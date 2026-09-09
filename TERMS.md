# YouCoded Terms of Service

**Effective date:** September 3, 2026

YouCoded ("YouCoded," "the app") is made and published by **Destin's Adventures, LLC**, an Arizona limited liability company ("the Company," "we," "our"). It is not affiliated with Anthropic. The app is open source and offered free of charge.

These Terms apply to your use of the YouCoded desktop and Android applications, the marketplace and theme registries (`wecoded-marketplace`, `wecoded-themes`), the marketplace Worker backend, the multiplayer game backend, and any other software or service distributed under the YouCoded name (collectively, the **"Services"**).

If you don't agree with these Terms, please don't use the Services. Continuing to use them means you accept these Terms.

---

## 1. The software itself

The YouCoded software is open source. Each repository carries its own LICENSE file, and **those licenses govern your rights to use, modify, and redistribute the source code itself.** In summary:

- The YouCoded desktop app and shared React UI are under the **MIT License**.
- The YouCoded Android app is also under the **MIT License**. It includes a vendored copy of Termux's terminal-emulator library, which is under the **Apache License 2.0** (see `terminal-emulator-vendored/LICENSE` and `NOTICE` in the youcoded repository).
- The marketplace and theme registries (`wecoded-marketplace`, `wecoded-themes`) are under the **Apache License 2.0**.
- Bundled plugins each carry their own license; check the relevant repository.

Nothing in these Terms reduces or replaces the rights granted to you by those open-source licenses. These Terms cover separate things: the **services** we host, the **content** you submit, and the **liability framing** that the open-source licenses already disclaim.

---

## 2. Eligibility

YouCoded is not directed at children under 13, and you must be at least 13 years old to use the Services. If you are under the age of majority where you live (18 in most places), you may use the Services only with the permission of a parent or legal guardian who agrees to these Terms on your behalf.

We do not knowingly collect personal data from children under 13 — see [PRIVACY.md](./PRIVACY.md). If you believe a child under 13 is using the Services, please contact us and we'll work with you to handle it.

---

## 3. Services we host

YouCoded operates a few small backend services that the app talks to:

- **Marketplace Worker** — a Cloudflare Worker at `wecoded-marketplace.workers.dev` (and related domains) that serves the plugin registry and accepts ratings and install pings.
- **Multiplayer game backend** — PartyKit rooms (on Cloudflare) used only while a game lobby or active game is in progress.
- **Analytics endpoint** — described in detail in [PRIVACY.md](./PRIVACY.md). Opt-out at any time in the app.
- **Static registries** — the theme and plugin registry data hosted via GitHub `raw.githubusercontent.com`.

These services are provided on a best-effort basis. We may modify, throttle, suspend, or discontinue any of them at any time, with or without notice. Because the app and registries are open source, anyone can fork and self-host their own backend if they need continuity guarantees we don't provide.

---

## 4. Acceptable use

When using the Services, you agree **not** to:

1. Attempt to access another user's data, account, GitHub identity, or device.
2. Probe, scan, or stress-test the Services beyond casual personal use, except for **good-faith security research** conducted under [SECURITY.md](./SECURITY.md).
3. Submit malware, credential stealers, cryptominers, tracking pixels, obfuscated payloads, or any other code intended to harm users or to extract data from them.
4. Submit content that infringes a third party's copyright, trademark, patent, trade secret, or other intellectual property right; that defames an identifiable person; that violates someone's privacy; or that is otherwise unlawful in the user's jurisdiction.
5. Use the Services to harass, threaten, or stalk any individual.
6. Use the Services in a way that violates Anthropic's terms governing Claude or Claude Code, or that violates any other third-party terms governing software or services that YouCoded interoperates with.
7. Misrepresent your identity when submitting content (impersonating someone else's GitHub identity, submitting under a stolen account, etc.).
8. Circumvent rate limits, abuse-prevention measures, or any access controls.
9. Resell or commercially exploit the marketplace Worker, the analytics endpoint, or the multiplayer game backend in ways that materially burden the project's costs.

We reserve the right to remove content, revoke marketplace publish privileges, or block access from specific accounts or IPs at our discretion if the Services are being abused. Open-source forks of the registries are not affected by such removals — anyone is free to host their own.

---

## 5. User content (marketplace and themes)

When you submit a plugin to `wecoded-marketplace` or a theme to `wecoded-themes` (each, **"User Content"**), you represent and warrant that:

1. You created the User Content yourself, or you have the right to submit it under the terms in this section.
2. The User Content does not infringe any third party's rights, contain malware, violate any law, or fall foul of Section 4 above.
3. You are not subject to any agreement or restriction that would prevent you from submitting the User Content.

**License you grant to YouCoded and to users of the Services:** you grant a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, copy, modify, host, distribute, sublicense, and create derivative works of your User Content for the purpose of operating and distributing the Services and the open-source projects associated with them. The licensed terms attached to the registry repositories themselves (Apache 2.0 — see each repository's LICENSE) define the terms downstream users receive your contribution under.

**You retain ownership of your User Content.** You can withdraw your contribution by opening an issue, opening a PR that removes it, or by emailing support@youcoded.ai — and we will pull it from the registry within a reasonable time. Note that copies that have already been redistributed under Apache 2.0 to downstream users cannot be retroactively unlicensed; that's how open source works.

**We do not pre-screen User Content** beyond automated CI checks (size limits, slug uniqueness, CSS-safety rules for themes, basic plugin-shape validation). The fact that a plugin or theme appears in the marketplace is not an endorsement of its quality, safety, or legality, and we do not warrant that user-submitted content is fit for any particular purpose.

---

## 6. Reporting infringement and abuse (DMCA & similar)

If you believe content in the marketplace, theme registry, or any other part of the Services infringes your copyright or other rights, please send a notice to:

- **Email:** support@youcoded.ai
- **Subject line:** `[YouCoded Takedown] <short description>`

A complete notice should include: identification of the work allegedly infringed; identification of the YouCoded content you want removed (URL or registry slug); your contact information; a statement that you have a good-faith belief the use is not authorized; a statement under penalty of perjury that the information is accurate and that you are authorized to act on the rights-owner's behalf; and your physical or electronic signature.

We respond to good-faith notices in good faith and aim to act on them promptly. If we remove content based on a notice and you believe the removal was a mistake, you may submit a counter-notice with the corresponding details. We may also forward notices and counter-notices to the original submitter to allow direct dispute resolution.

This Section is the YouCoded process for handling infringement claims under the DMCA's takedown framework. Our designated agent, registered with the U.S. Copyright Office (DMCA Designated Agent Directory registration DMCA-1079861), is:

- **Destin Moss**, Member, Destin's Adventures, LLC
- 14002 N 49th Ave, Unit 1023, Glendale, AZ 85306, United States
- support@youcoded.ai

Notices sent to the email address above reach the designated agent.

---

## 7. Third-party content and services

The Services interoperate with third-party software and services — including Anthropic's Claude and Claude Code, OpenAI and ChatGPT, OpenRouter and its model providers, GitHub, Cloudflare, Termux, Google Drive, and user-configured providers, tools, and integrations. **We are not responsible** for those services. Their availability, behavior, data handling, retention, and terms are governed by them, not by us. Disruptions in third-party services may affect the Services, and your use of those services is governed by the corresponding third party's terms and privacy policy.

When you choose a cloud model or connected service, you authorize YouCoded to send the content needed for that request to that service. The service may retain or otherwise handle that content under its own policies; YouCoded cannot control or delete records held by it. Local-model inference does not send an inference request to a cloud model provider. See [PRIVACY.md](./PRIVACY.md) for the data-flow details and the limits of that statement.

References to third-party trademarks (Anthropic, Claude, Claude Code, OpenAI, ChatGPT, OpenRouter, GitHub, Termux, etc.) appear only to identify those products. Such references do not imply affiliation, endorsement, or sponsorship.

---

## 8. Disclaimer of warranty

THE SERVICES AND ALL SOFTWARE DISTRIBUTED UNDER THE YOUCODED NAME ARE PROVIDED **"AS IS"** AND **"AS AVAILABLE,"** WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, OR THAT THE SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.

YouCoded is a small project run by one person. We make no promises about uptime, latency, support response times, or feature stability. Major versions may break compatibility. Backends may be retired with limited notice. Bugs may exist that we never get to.

YOU USE THE SERVICES AT YOUR OWN RISK.

---

## 9. Limitation of liability

TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL YOUCODED, DESTIN'S ADVENTURES, LLC, ITS MEMBERS, OR ITS CONTRIBUTORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, GOODWILL, USE, DATA, OR OTHER INTANGIBLE LOSSES, ARISING FROM OR RELATING TO YOUR USE OF — OR INABILITY TO USE — THE SERVICES, EVEN IF WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

THE AGGREGATE LIABILITY OF YOUCODED, DESTIN'S ADVENTURES, LLC, ITS MEMBERS, AND ITS CONTRIBUTORS FOR ANY AND ALL CLAIMS RELATED TO THE SERVICES — WHETHER IN CONTRACT, TORT, OR ANY OTHER THEORY — IS LIMITED TO **ONE HUNDRED U.S. DOLLARS (US $100)**, OR THE AMOUNT YOU PAID US FOR THE SERVICES IN THE TWELVE MONTHS BEFORE THE CLAIM AROSE, WHICHEVER IS GREATER. (Because YouCoded is offered free of charge, this typically means $100.)

Some jurisdictions do not allow the exclusion or limitation of certain warranties or damages. To the extent any limitation in this Section is unenforceable in your jurisdiction, the remaining limitations remain in effect.

---

## 10. Indemnification

You agree to indemnify, defend, and hold harmless YouCoded, Destin's Adventures, LLC, its members, and its contributors from any claim, demand, loss, or damage — including reasonable attorney's fees — arising from (a) User Content you submit, (b) your violation of these Terms, or (c) your violation of any third party's rights through your use of the Services.

We reserve the right to assume the exclusive defense and control of any matter otherwise subject to indemnification by you, in which case you agree to cooperate with our defense.

---

## 11. Termination

You may stop using the Services at any time. We may suspend or terminate your access to the Services (in whole or in part) at any time if we believe you have violated these Terms or if continued provision creates risk for the project or other users. Sections 5 (license you grant), 6 (takedown), 8 (warranty disclaimer), 9 (limitation of liability), 10 (indemnification), 12 (modifications), 14 (governing law), 15 (disputes), and 16 (general) survive termination.

---

## 12. Modifications to these Terms

We may update these Terms from time to time. When we do, we'll change the **Effective date** at the top and push the new file to the YouCoded repository. The current version always lives at `https://github.com/itsdestin/youcoded/blob/master/TERMS.md`. Material changes will be flagged in the in-app announcement system where practical. Your continued use of the Services after changes take effect constitutes acceptance of the new Terms.

---

## 13. No agency, employment, or partnership

Nothing in these Terms creates an employment relationship, partnership, joint venture, agency, or fiduciary relationship between you and YouCoded. Contributors to the open-source repositories are independent contributors, not agents or employees.

---

## 14. Governing law

These Terms are governed by the laws of the **State of Arizona, United States**, without regard to its conflict-of-laws rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply.

---

## 15. Disputes

We hope it never comes to this, but: any dispute arising out of or relating to these Terms or the Services shall be resolved exclusively in the **state or federal courts located in Maricopa County, Arizona**, and you consent to personal jurisdiction in those courts. To the extent permitted by applicable law, you and YouCoded each waive the right to a jury trial and the right to participate in class actions related to the Services — claims must be brought individually.

If you are a consumer in a jurisdiction that grants you a non-waivable right to bring claims in your local courts under your local law, nothing in this Section overrides those rights.

---

## 16. General

- **Severability.** If any part of these Terms is found unenforceable, the remainder stays in effect, and the unenforceable part is replaced by the closest enforceable equivalent that reflects the original intent.
- **No waiver.** Our failure to enforce any right under these Terms is not a waiver of that right.
- **Assignment.** You may not assign these Terms without our written consent. We may assign these Terms to a successor entity (for example, if the project is transferred to another company or to a non-profit organization).
- **Entire agreement.** These Terms, together with the Privacy Policy and the open-source licenses attached to the relevant repositories, constitute the entire agreement between you and YouCoded regarding the Services. They supersede any prior agreements on the same subject matter.

---

## 17. Contact

Destin's Adventures, LLC, Arizona, United States.

- **Email:** support@youcoded.ai
- **Source:** https://github.com/itsdestin/youcoded
- **Privacy questions:** see [PRIVACY.md](./PRIVACY.md)
- **Security issues:** see [SECURITY.md](./SECURITY.md)
