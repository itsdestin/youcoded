/*
 * glibc-loader.c — Bionic-compatible ELF loader for glibc's ld-linux
 *
 * Loads BOTH glibc's ld-linux AND the target program into memory (without
 * relocation), then jumps to ld-linux's entry point with proper auxv —
 * exactly simulating what the Linux kernel does.
 *
 * This uses "interpreter mode": ld-linux sees AT_PHDR pointing to the
 * already-mapped program's phdrs and AT_BASE pointing to its own load
 * address, so it skips file loading and just does relocation + deps.
 *
 * Usage: /system/bin/linker64 glibc-loader <ld-linux.so> <program> [args...]
 *
 * Compile: zig cc -target aarch64-linux-musl -O2 -static-pie -fPIE -o glibc-loader glibc-loader.c
 */

#include <elf.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/mman.h>
#include <unistd.h>

static void errstr(const char *s) { write(2, s, strlen(s)); }
static void die(const char *msg) {
    errstr("glibc-loader: ");
    errstr(msg);
    errstr("\n");
    _exit(1);
}

static int read_ehdr(int fd, Elf64_Ehdr *ehdr) {
    if (pread(fd, ehdr, sizeof(*ehdr), 0) != sizeof(*ehdr)) return -1;
    if (memcmp(ehdr->e_ident, ELFMAG, SELFMAG) != 0) return -1;
    if (ehdr->e_ident[EI_CLASS] != ELFCLASS64) return -1;
    if (ehdr->e_machine != EM_AARCH64) return -1;
    return 0;
}

/*
 * Map an ELF's LOAD segments into memory. Returns load bias.
 * For ET_EXEC, maps at fixed addresses (bias=0).
 * For ET_DYN, maps at a kernel-chosen base.
 */
static uintptr_t map_elf(int fd, Elf64_Ehdr *ehdr) {
    Elf64_Phdr phdrs[32];
    int phnum = ehdr->e_phnum;
    if (phnum > 32) die("too many phdrs");
    if (pread(fd, phdrs, phnum * sizeof(Elf64_Phdr), ehdr->e_phoff)
        != (ssize_t)(phnum * sizeof(Elf64_Phdr)))
        die("read phdrs");

    long page_size = sysconf(_SC_PAGESIZE);

    /* Find address range */
    uintptr_t lo = (uintptr_t)-1, hi = 0;
    for (int i = 0; i < phnum; i++) {
        if (phdrs[i].p_type != PT_LOAD) continue;
        uintptr_t seg_lo = phdrs[i].p_vaddr;
        uintptr_t seg_hi = phdrs[i].p_vaddr + phdrs[i].p_memsz;
        if (seg_lo < lo) lo = seg_lo;
        if (seg_hi > hi) hi = seg_hi;
    }
    lo &= ~(page_size - 1);
    hi = (hi + page_size - 1) & ~(page_size - 1);

    uintptr_t load_bias;
    if (ehdr->e_type == ET_EXEC) {
        /* Fixed addresses — reserve the exact range */
        void *base = mmap((void *)lo, hi - lo, PROT_NONE,
                          MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
        if (base == MAP_FAILED) {
            /* Try without NOREPLACE */
            base = mmap((void *)lo, hi - lo, PROT_NONE,
                        MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
            if (base == MAP_FAILED) die("mmap reserve ET_EXEC");
        }
        load_bias = (uintptr_t)base - lo;
    } else {
        /* PIE — let kernel choose */
        void *base = mmap(NULL, hi - lo, PROT_NONE,
                          MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (base == MAP_FAILED) die("mmap reserve");
        load_bias = (uintptr_t)base - lo;
    }

    /* Map each LOAD segment */
    for (int i = 0; i < phnum; i++) {
        if (phdrs[i].p_type != PT_LOAD) continue;

        int prot = 0;
        if (phdrs[i].p_flags & PF_R) prot |= PROT_READ;
        if (phdrs[i].p_flags & PF_W) prot |= PROT_WRITE;
        if (phdrs[i].p_flags & PF_X) prot |= PROT_EXEC;

        uintptr_t seg_start = phdrs[i].p_vaddr + load_bias;
        uintptr_t map_start = seg_start & ~(page_size - 1);
        uintptr_t map_end = (seg_start + phdrs[i].p_memsz + page_size - 1)
                            & ~(page_size - 1);
        off_t map_off = phdrs[i].p_offset & ~(page_size - 1);

        /* Map file-backed portion */
        uintptr_t file_end = seg_start + phdrs[i].p_filesz;
        uintptr_t file_map_end = (file_end + page_size - 1) & ~(page_size - 1);
        size_t file_map_len = file_map_end - map_start;
        if (file_map_len > map_end - map_start)
            file_map_len = map_end - map_start;

        int mmap_prot = prot;
        /* Add PROT_WRITE temporarily if we need to zero BSS in this segment */
        if (phdrs[i].p_memsz > phdrs[i].p_filesz)
            mmap_prot |= PROT_WRITE;
        void *seg = mmap((void *)map_start, file_map_len,
                         mmap_prot,
                         MAP_PRIVATE | MAP_FIXED, fd, map_off);
        if (seg == MAP_FAILED) die("mmap segment");

        /* Zero BSS (bytes between filesz and memsz) */
        if (phdrs[i].p_memsz > phdrs[i].p_filesz) {
            uintptr_t bss_start = seg_start + phdrs[i].p_filesz;
            uintptr_t bss_end = seg_start + phdrs[i].p_memsz;
            /* Zero tail of last file-mapped page */
            uintptr_t zero_end = file_map_end < bss_end ? file_map_end : bss_end;
            if (zero_end > bss_start)
                memset((void *)bss_start, 0, zero_end - bss_start);
            /* Map anonymous pages for remaining BSS */
            if (file_map_end < map_end) {
                mmap((void *)file_map_end, map_end - file_map_end,
                     prot, MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS, -1, 0);
            }
        }

        /* Restore correct permissions (only if we added PROT_WRITE for BSS) */
        if (phdrs[i].p_memsz > phdrs[i].p_filesz && !(phdrs[i].p_flags & PF_W))
            mprotect((void *)map_start, map_end - map_start, prot);
    }
    return load_bias;
}

extern void __attribute__((noreturn))
jump_to_entry(uintptr_t entry, void *stack);

__asm__(
    ".global jump_to_entry\n"
    "jump_to_entry:\n"
    "   mov sp, x1\n"
    "   mov x16, x0\n"
    "   mov x0, #0\n"
    "   mov x1, #0\n"
    "   mov x2, #0\n"
    "   mov x3, #0\n"
    "   mov x29, #0\n"
    "   mov x30, #0\n"
    "   br x16\n"
);

int main(int argc, char **argv, char **envp) {
    /* linker64 sets argv[0] to itself and argv[1] to our binary.
     * Skip past our own name to find the real arguments. */
    int arg_start = 1; /* default: argv[1] is ld-linux */
    /* If argv[0] contains "linker64", we're invoked via linker64 and
     * argv[1] is our own path, so real args start at argv[2] */
    if (argc >= 2 && strstr(argv[0], "linker64"))
        arg_start = 2;

    if (argc - arg_start < 2) {
        errstr("Usage: glibc-loader <ld-linux.so> <program> [args...]\n");
        _exit(1);
    }

    const char *ldlinux_path = argv[arg_start];

    /* 1. Map ld-linux (unrelocated, just like kernel does) */
    errstr("mapping ld-linux...\n");
    int ld_fd = open(ldlinux_path, O_RDONLY);
    if (ld_fd < 0) die("open ld-linux");
    Elf64_Ehdr ld_ehdr;
    if (read_ehdr(ld_fd, &ld_ehdr) < 0) die("bad ld-linux ELF");
    uintptr_t ld_bias = map_elf(ld_fd, &ld_ehdr);
    uintptr_t ld_entry = ld_ehdr.e_entry + ld_bias;
    close(ld_fd);
    errstr("ld-linux mapped OK\n");

    /* ld-linux's mapped phdrs (in the loaded image) */
    Elf64_Phdr *ld_phdr = (Elf64_Phdr *)(ld_bias + ld_ehdr.e_phoff);

    /* Command mode: ld-linux IS the program.
     * Pass all remaining args (after ld-linux path) as ld-linux's argv.
     * ld-linux will parse --library-path, find the program, open & map it. */
    int new_argc = argc - arg_start;  /* include ld-linux path as argv[0] */
    char **new_argv = &argv[arg_start];

    /* Count envp */
    int envc = 0;
    while (envp[envc]) envc++;

    /* Inject LD_LIBRARY_PATH if not already set */
    /* (caller should set it via environment) */

    /* Random bytes for AT_RANDOM */
    unsigned char random_bytes[16];
    int rfd = open("/dev/urandom", O_RDONLY);
    if (rfd >= 0) { read(rfd, random_bytes, 16); close(rfd); }

    /* 4. Build new stack */
    size_t stack_size = 1024 * 1024;
    void *stack_base = mmap(NULL, stack_size, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS | MAP_STACK, -1, 0);
    if (stack_base == MAP_FAILED) die("mmap stack");

    uintptr_t *sp = (uintptr_t *)((char *)stack_base + stack_size);
    sp = (uintptr_t *)((uintptr_t)sp & ~15UL);

    /* Place random bytes and execfn string at top of stack */
    sp -= 2;
    memcpy(sp, random_bytes, 16);
    uintptr_t random_addr = (uintptr_t)sp;

    size_t execfn_len = strlen(ldlinux_path) + 1;
    sp = (uintptr_t *)((uintptr_t)sp - ((execfn_len + 15) & ~15UL));
    memcpy(sp, ldlinux_path, execfn_len);
    uintptr_t execfn_addr = (uintptr_t)sp;

    /* 5. Build auxiliary vector — COMMAND MODE
     * AT_PHDR  → ld-linux's own phdrs (it IS the program)
     * AT_ENTRY → ld-linux's entry point
     * AT_BASE  → 0 (no separate interpreter)
     */
    #define AUX_CNT 12
    Elf64_auxv_t auxv[AUX_CNT + 1];
    int ai = 0;
    auxv[ai].a_type = AT_PHDR;    auxv[ai].a_un.a_val = (uintptr_t)ld_phdr; ai++;
    auxv[ai].a_type = AT_PHENT;   auxv[ai].a_un.a_val = sizeof(Elf64_Phdr); ai++;
    auxv[ai].a_type = AT_PHNUM;   auxv[ai].a_un.a_val = ld_ehdr.e_phnum; ai++;
    auxv[ai].a_type = AT_PAGESZ;  auxv[ai].a_un.a_val = sysconf(_SC_PAGESIZE); ai++;
    auxv[ai].a_type = AT_BASE;    auxv[ai].a_un.a_val = 0; ai++;
    auxv[ai].a_type = AT_ENTRY;   auxv[ai].a_un.a_val = ld_entry; ai++;
    auxv[ai].a_type = AT_FLAGS;   auxv[ai].a_un.a_val = 0; ai++;
    auxv[ai].a_type = AT_UID;     auxv[ai].a_un.a_val = getuid(); ai++;
    auxv[ai].a_type = AT_GID;     auxv[ai].a_un.a_val = getgid(); ai++;
    auxv[ai].a_type = AT_RANDOM;  auxv[ai].a_un.a_val = random_addr; ai++;
    auxv[ai].a_type = AT_EXECFN;  auxv[ai].a_un.a_val = execfn_addr; ai++;
    auxv[ai].a_type = AT_SECURE;  auxv[ai].a_un.a_val = 0; ai++;
    auxv[ai].a_type = AT_NULL;    auxv[ai].a_un.a_val = 0; ai++;

    /* Calculate frame size and build it */
    size_t frame_size = sizeof(uintptr_t)
                      + (new_argc + 1) * sizeof(uintptr_t)
                      + (envc + 1) * sizeof(uintptr_t)
                      + ai * sizeof(Elf64_auxv_t);

    sp = (uintptr_t *)((uintptr_t)sp - ((frame_size + 15) & ~15UL));

    uintptr_t *frame = sp;
    *frame++ = new_argc;
    for (int i = 0; i < new_argc; i++)
        *frame++ = (uintptr_t)new_argv[i];
    *frame++ = 0;
    for (int i = 0; i < envc; i++)
        *frame++ = (uintptr_t)envp[i];
    *frame++ = 0;
    memcpy(frame, auxv, ai * sizeof(Elf64_auxv_t));

    /* 6. Verify stack layout before jump */
    {
        char hex[32];
        uintptr_t *p = sp;
        errstr("stack[0] argc=");
        int v = (int)*p; hex[0]='0'+v; hex[1]='\n'; write(2,hex,2);
        p++; /* argv[0] */
        errstr("argv[0]="); errstr((char*)*p); errstr("\n");

        /* Print AT_BASE value */
        char buf[80];
        int len = 0;
        buf[len++]='B'; buf[len++]='A'; buf[len++]='S'; buf[len++]='E'; buf[len++]='=';
        uintptr_t bv = ld_bias;
        for (int s = 60; s >= 0; s -= 4) {
            int nib = (bv >> s) & 0xf;
            buf[len++] = nib < 10 ? '0'+nib : 'a'+nib-10;
        }
        buf[len++] = '\n';
        write(2, buf, len);

        errstr("jumping to ld-linux entry...\n");
    }
    jump_to_entry(ld_entry, sp);
    return 0;
}
