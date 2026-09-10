// The one sentence under a Skip Permissions toggle.
//
// WHY IT IS A COMPONENT (2026-09-10). This markup existed five times, byte for
// byte, across every form that can start a conversation: the welcome form,
// SessionStrip's, the Resume Browser's, ResumeOptionsPopover's and the buddy
// floater's. tests/field-error-adoption.test.ts had to carry four named
// exemptions for it, and its own comment said so: "their real problem is that
// there are four of them; the fix is a shared warning component, not this
// primitive." Adding the buddy's would have made five.
//
// Deliberately NOT <FieldError>, which is what those exemptions were about.
// FieldError carries role="alert" — correct for "that didn't work", wrong here:
// this is always-on caption copy, so a screen reader would interrupt with it
// every single time the toggle flips.
//
// It lives outside components/ui/ on purpose. It is one app-specific sentence,
// not a reusable primitive, and primitive-adoption.test.ts rightly polices what
// goes in that folder.
export function SkipPermissionsCaption() {
  return (
    <p className="text-3xs text-destructive-fg m-0">
      Claude will execute tools without asking for approval.
    </p>
  );
}
