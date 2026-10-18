"""Exercise the actual backend trim commands against disposable package trees."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class BackendLicensesTest(unittest.TestCase):
    def test_trimming_keeps_dependency_license_notice_and_readme_files(self):
        script = Path(__file__).with_name("build-backend.sh").read_text()
        # WHY: execute the shell's real trim section, without installing npm or compiling
        # the app; this catches legal-file deletion even when it is moved between commands.
        trim = script.split('say "trimming"', 1)[1].split('tar czf', 1)[0]
        legal_files = [
            "jose/LICENSE.md", "jszip/LICENSE.markdown",
            "@mozilla/readability/LICENSE.md", "vendor/docs/NOTICE",
            "node-pty/third_party/LICENSE.md", "example/README.md",
        ]
        with tempfile.TemporaryDirectory(prefix="yc-backend-license-") as root:
            stage = Path(root)
            modules = stage / "node_modules"
            for relative in legal_files + ["example/unused.js.map", "example/types.d.ts"]:
                file = modules / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("copyright and permission notice\n")
            here = str(Path(__file__).parent.resolve())
            subprocess.run(["python3", "-I", str(Path(here) / "preserve-npm-legal.py"), str(modules), str(stage / "legal")], check=True)
            subprocess.run(["bash", "-eu", "-c", trim], env={**os.environ, "STAGE": root, "HERE": here}, check=True)
            for relative in legal_files:
                self.assertTrue((modules / relative).is_file(), f"trim deleted legal material: {relative}")
                self.assertEqual((modules / relative).read_text(), "copyright and permission notice\n")
            self.assertFalse((modules / "example/unused.js.map").exists())
            self.assertFalse((modules / "example/types.d.ts").exists())


if __name__ == "__main__":
    unittest.main()
