# Contributing to YouCoded

Thanks for helping. YouCoded is built and maintained through conversation with AI by someone who does not write code by hand, so clear descriptions matter more than clever diffs.

## Proposing a change

- **Bugs and ideas:** open an [issue](https://github.com/itsdestin/youcoded/issues). Say what you did, what happened, and what you expected — platform (Windows / macOS / Linux / Android) and app version included.
- **Code, docs, tests:** fork, branch, and open a pull request against `master`. Keep each PR to one change and explain in the description what a user will notice.
- **Security problems:** do **not** open a public issue. Follow [SECURITY.md](./SECURITY.md).

## Sign-off (DCO)

Every commit must carry a `Signed-off-by` line with your real name and email:

```
Signed-off-by: Jane Doe <jane@example.com>
```

`git commit -s` adds it for you. Signing off means you agree to the [Developer Certificate of Origin 1.1](https://developercertificate.org/), quoted here in full:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

There is no bot and no CI check for this today; a PR with unsigned commits will be asked to add the line (`git commit --amend -s`, or `git rebase --signoff`) before it is merged.

## License of contributions

Contributions are accepted under the license that already covers the files you touch — the [MIT License](./LICENSE) for the desktop app, the Android app, the shared React UI, scripts and docs, unless a file says otherwise. By signing off, you confirm you have the right to submit the contribution under that license, and you agree that it may be relicensed together with the rest of the project if the project's license ever changes.
