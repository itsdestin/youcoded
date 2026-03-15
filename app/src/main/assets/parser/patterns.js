// Patterns are populated after pattern discovery.
// These are initial best-guesses; refine after capturing real output.

module.exports = {
  approval: [
    /Allow\s+(.*?)\s*\?\s*\[?(y\/n|Y\/n|yes\/no)\]?/,
    /Do you want to (.*?)\?\s*\[?(y\/n)\]?/,
    /\? (Allow|Deny|Accept|Reject)/,
    /Press y to allow/i,
  ],

  toolCall: [
    /^(Read|Write|Edit|Bash|Glob|Grep|Agent|Skill)\s*[:(]/,
  ],

  ansiStrip: /\x1B\[[0-9;]*[a-zA-Z]/g,
};
