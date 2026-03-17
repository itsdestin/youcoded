/*
 * glibc-loader.c — Bionic-compatible ELF loader for glibc's ld-linux
 *
 * Problem: bionic's linker64 double-relocates ld-linux when loading it as a
 * program, causing ld-linux's bootstrap self-relocation to corrupt pointers.
 *
 * Solution: This tiny program is loaded by bionic's linker64 (it links against
 * bionic). It then manually mmap()s glibc's ld-linux-aarch64.so.1 into memory
 * WITHOUT relocation, constructs a proper auxiliary vector, and jumps to
 * ld-linux's entry point — exactly like the Linux kernel would.
 *
 * Usage: /system/bin/linker64 glibc-loader /path/to/ld-linux /path/to/program [args...]
 *
 * Compile: zig cc -target aarch64-linux-android -static-libgcc -O2 -o glibc-loader glibc-loader.c
 */

#include <elf.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/mman.h>
#include <unistd.h>

/* Write a string to stderr */
static void errstr(const char *s) {
    write(2, s, strlen(s));
}

static void die(const char *msg) {
    errstr("glibc-loader: ");
    errstr(msg);
    errstr("\n");
    _exit(1);
}

/* Read and validate ELF header */
static int read_ehdr(int fd, Elf64_Ehdr *ehdr) {
    if (pread(fd, ehdr, sizeof(*ehdr), 0) != sizeof(*ehdr))
        return -1;
    if (memcmp(ehdr->e_ident, ELFMAG, SELFMAG) != 0)
        return -1;
    if (ehdr->e_ident[EI_CLASS] != ELFCLASS64)
        return -1;
    if (ehdr->e_machine != EM_AARCH64)
        return -1;
    return 0;
}

/* Map an ELF's LOAD segments into memory. Returns load bias. */
static uintptr_t map_elf(int fd, Elf64_Ehdr *ehdr) {
    Elf64_Phdr phdrs[32];
    int phnum = ehdr->e_phnum;
    if (phnum > 32) die("too many phdrs");

    if (pread(fd, phdrs, phnum * sizeof(Elf64_Phdr), ehdr->e_phoff)
        != (ssize_t)(phnum * sizeof(Elf64_Phdr)))
        die("read phdrs");

    /* Find total address range needed */
    uintptr_t lo = (uintptr_t)-1, hi = 0;
    for (int i = 0; i < phnum; i++) {
        if (phdrs[i].p_type != PT_LOAD) continue;
        uintptr_t seg_lo = phdrs[i].p_vaddr;
        uintptr_t seg_hi = phdrs[i].p_vaddr + phdrs[i].p_memsz;
        if (seg_lo < lo) lo = seg_lo;
        if (seg_hi > hi) hi = seg_hi;
    }

    long page_size = sysconf(_SC_PAGESIZE);
    lo &= ~(page_size - 1);
    hi = (hi + page_size - 1) & ~(page_size - 1);

    /* Reserve address range with anonymous mmap */
    void *base = mmap(NULL, hi - lo, PROT_NONE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (base == MAP_FAILED) die("mmap reserve");

    uintptr_t load_bias = (uintptr_t)base - lo;

    /* Map each LOAD segment */
    for (int i = 0; i < phnum; i++) {
        if (phdrs[i].p_type != PT_LOAD) continue;

        int prot = 0;
        if (phdrs[i].p_flags & PF_R) prot |= PROT_READ;
        if (phdrs[i].p_flags & PF_W) prot |= PROT_WRITE;
        if (phdrs[i].p_flags & PF_X) prot |= PROT_EXEC;

        uintptr_t map_start = (phdrs[i].p_vaddr + load_bias) & ~(page_size - 1);
        uintptr_t map_end = ((phdrs[i].p_vaddr + load_bias + phdrs[i].p_memsz)
                             + page_size - 1) & ~(page_size - 1);
        off_t map_off = phdrs[i].p_offset & ~(page_size - 1);
        size_t map_len = map_end - map_start;

        /* File-backed portion */
        size_t file_end = phdrs[i].p_offset + phdrs[i].p_filesz;
        size_t file_map_end = (file_end + page_size - 1) & ~(page_size - 1);
        size_t file_map_len = file_map_end - (phdrs[i].p_offset & ~(page_size - 1));
        if (file_map_len > map_len) file_map_len = map_len;

        void *seg = mmap((void *)map_start, file_map_len,
                         prot | PROT_WRITE, /* need write for BSS zeroing */
                         MAP_PRIVATE | MAP_FIXED, fd, map_off);
        if (seg == MAP_FAILED) die("mmap segment");

        /* Zero BSS portion (memsz > filesz) */
        uintptr_t bss_start = phdrs[i].p_vaddr + load_bias + phdrs[i].p_filesz;
        uintptr_t bss_end = phdrs[i].p_vaddr + load_bias + phdrs[i].p_memsz;
        if (bss_end > bss_start) {
            /* Zero remaining bytes in the file-mapped page */
            uintptr_t page_bss_end = (bss_start + page_size - 1) & ~(page_size - 1);
            if (page_bss_end > file_map_end + map_start - map_start) {
                /* just zero from bss_start to end of mapped region */
            }
            memset((void *)bss_start, 0, bss_end - bss_start > 4096 ? 4096 : bss_end - bss_start);

            /* If BSS extends beyond the file mapping, map anonymous pages */
            uintptr_t anon_start = (bss_start + page_size - 1) & ~(page_size - 1);
            if (anon_start < map_end && anon_start >= map_start + file_map_len) {
                void *anon = mmap((void *)anon_start, map_end - anon_start,
                                  prot, MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS, -1, 0);
                if (anon == MAP_FAILED) die("mmap bss");
            }
        }

        /* Remove write permission if not in original flags */
        if (!(phdrs[i].p_flags & PF_W)) {
            mprotect((void *)map_start, map_len, prot);
        }
    }

    return load_bias;
}

/*
 * Build a new stack with: argc, argv, envp, auxv
 * and jump to ld-linux's entry point.
 *
 * This must be done in assembly because we need to completely replace
 * the current stack frame with the new layout.
 */
extern void __attribute__((noreturn))
jump_to_entry(uintptr_t entry, void *stack);

/* Implemented in inline asm below */
__asm__(
    ".global jump_to_entry\n"
    "jump_to_entry:\n"
    "   mov sp, x1\n"      /* set stack pointer */
    "   mov x16, x0\n"     /* save entry point */
    "   mov x0, #0\n"      /* clear registers (ABI) */
    "   mov x1, #0\n"
    "   mov x2, #0\n"
    "   mov x3, #0\n"
    "   mov x29, #0\n"     /* clear frame pointer */
    "   mov x30, #0\n"     /* clear link register */
    "   br x16\n"          /* jump to entry point */
);

int main(int argc, char **argv, char **envp) {
    if (argc < 3) {
        errstr("Usage: glibc-loader <ld-linux.so> <program> [args...]\n");
        _exit(1);
    }

    const char *ldlinux_path = argv[1];
    /* argv[2..] becomes the new argv for ld-linux */

    /* Open and map ld-linux */
    int ld_fd = open(ldlinux_path, O_RDONLY);
    if (ld_fd < 0) die("open ld-linux");

    Elf64_Ehdr ld_ehdr;
    if (read_ehdr(ld_fd, &ld_ehdr) < 0) die("bad ld-linux ELF");

    uintptr_t ld_bias = map_elf(ld_fd, &ld_ehdr);
    uintptr_t ld_entry = ld_ehdr.e_entry + ld_bias;
    close(ld_fd);

    /* Read ld-linux's phdrs from the mapped image */
    Elf64_Phdr *ld_phdr = (Elf64_Phdr *)(ld_bias + ld_ehdr.e_phoff);

    /* We DON'T open or map the target program — ld-linux will do that.
     * ld-linux reads the program path from its argv (the --library-path and
     * program args we pass through). The auxv tells ld-linux about ITSELF. */

    /* Count envp */
    int envc = 0;
    while (envp[envc]) envc++;

    /* Build new argc/argv: ld-linux gets --library-path <glibc-dir> <program> [args...] */
    /* Actually, simpler: pass argv[2..] directly. The caller (our shell wrapper)
     * will include --library-path in argv[2..] if needed.
     * ld-linux's argv = argv[1..] (ld-linux path is argv[0] for it, then program is argv[1]) */
    int new_argc = argc - 1;  /* skip our own argv[0] */
    char **new_argv = &argv[1]; /* starts with ld-linux path */

    /* Build the stack:
     * [sp+0]       = new_argc
     * [sp+8..]     = new_argv[0..new_argc-1], NULL
     * [..]         = envp[0..envc-1], NULL
     * [..]         = auxv entries
     */

    /* Random bytes for AT_RANDOM */
    unsigned char random_bytes[16];
    int rfd = open("/dev/urandom", O_RDONLY);
    if (rfd >= 0) { read(rfd, random_bytes, 16); close(rfd); }

    /* Allocate stack (we'll mmap a fresh one) */
    size_t stack_size = 1024 * 1024; /* 1MB */
    void *stack_base = mmap(NULL, stack_size, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK, -1, 0);
    if (stack_base == MAP_FAILED) die("mmap stack");

    /* Build from the top of the stack, growing downward */
    uintptr_t *sp = (uintptr_t *)((char *)stack_base + stack_size);

    /* Align to 16 bytes */
    sp = (uintptr_t *)((uintptr_t)sp & ~15UL);

    /* Strings (random bytes) — place at the top */
    sp -= 2; /* 16 bytes for AT_RANDOM */
    memcpy(sp, random_bytes, 16);
    uintptr_t random_addr = (uintptr_t)sp;

    /* Null-terminated AT_EXECFN string */
    /* Use the ld-linux path as execfn */
    size_t execfn_len = strlen(ldlinux_path) + 1;
    sp = (uintptr_t *)((uintptr_t)sp - ((execfn_len + 15) & ~15UL));
    memcpy(sp, ldlinux_path, execfn_len);
    uintptr_t execfn_addr = (uintptr_t)sp;

    /* Now build the structured part from bottom up.
     * We need to pre-calculate the total size. Easier to just build it. */

    /* Auxiliary vector entries */
    #define AUX_CNT 10
    Elf64_auxv_t auxv[AUX_CNT + 1]; /* +1 for AT_NULL */
    int ai = 0;
    auxv[ai].a_type = AT_PHDR;    auxv[ai].a_un.a_val = (uintptr_t)ld_phdr; ai++;
    auxv[ai].a_type = AT_PHENT;   auxv[ai].a_un.a_val = sizeof(Elf64_Phdr); ai++;
    auxv[ai].a_type = AT_PHNUM;   auxv[ai].a_un.a_val = ld_ehdr.e_phnum; ai++;
    auxv[ai].a_type = AT_PAGESZ;  auxv[ai].a_un.a_val = sysconf(_SC_PAGESIZE); ai++;
    auxv[ai].a_type = AT_ENTRY;   auxv[ai].a_un.a_val = ld_entry; ai++;
    auxv[ai].a_type = AT_BASE;    auxv[ai].a_un.a_val = 0; ai++;
    auxv[ai].a_type = AT_FLAGS;   auxv[ai].a_un.a_val = 0; ai++;
    auxv[ai].a_type = AT_RANDOM;  auxv[ai].a_un.a_val = random_addr; ai++;
    auxv[ai].a_type = AT_EXECFN;  auxv[ai].a_un.a_val = execfn_addr; ai++;
    auxv[ai].a_type = AT_SECURE;  auxv[ai].a_un.a_val = 0; ai++;
    auxv[ai].a_type = AT_NULL;    auxv[ai].a_un.a_val = 0; ai++;

    /* Calculate total stack frame size */
    size_t frame_size = sizeof(uintptr_t)                    /* argc */
                      + (new_argc + 1) * sizeof(uintptr_t)   /* argv + NULL */
                      + (envc + 1) * sizeof(uintptr_t)        /* envp + NULL */
                      + ai * sizeof(Elf64_auxv_t);            /* auxv */

    /* Align frame start */
    sp = (uintptr_t *)((uintptr_t)sp - ((frame_size + 15) & ~15UL));

    /* Write argc */
    uintptr_t *frame = sp;
    *frame++ = new_argc;

    /* Write argv pointers */
    for (int i = 0; i < new_argc; i++)
        *frame++ = (uintptr_t)new_argv[i];
    *frame++ = 0; /* NULL terminator */

    /* Write envp pointers */
    for (int i = 0; i < envc; i++)
        *frame++ = (uintptr_t)envp[i];
    *frame++ = 0; /* NULL terminator */

    /* Write auxv */
    memcpy(frame, auxv, ai * sizeof(Elf64_auxv_t));

    /* Jump! */
    jump_to_entry(ld_entry, sp);

    /* unreachable */
    return 0;
}
