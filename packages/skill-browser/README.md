# skill-browser

Shared plumbing for the browser-driving skill CLIs in this repo
(`three-bill`, `hyperoptic-bill`, `peloton-invoice`). Each CLI drives its own
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python)
Chromium on a dedicated profile (`~/.<tool>/profile`), never your everyday
Chrome and never a `--remote-debugging-port` instance.

| Module | What it gives a tool |
| --- | --- |
| `browser` | `BrowserManager` and `open_profile`: one persistent context per profile, bounded teardown, cancel-safe start and close. `Tool(keep_session_cookies=True)` carries no-expiry cookies across runs in `~/.<tool>/session-cookies.json` (0600), because Chromium drops them on exit |
| `lease` | An `flock` on `~/.<tool>/profile.lock`, released only on a *confirmed* browser close, plus a refusal when a stray Chromium still owns the profile |
| `login` | `human_login`: a headed window, the human signs in, the tool polls a site-specific `is_signed_in` check until it passes 3 times in a row |
| `nav` | `goto` that turns navigation failures into typed errors naming no URL, `wait_off_barrier` (lets an SSO bounce come back before deciding "signed out"), and `wait_for_stable_text` |
| `errors` | Typed errors with one exit code per failure class (table below) |
| `cli` | `Tool`, `build_parser` (global flags, `login`, `install-browser`), `add_output_args` (`--out`, `--overwrite`), `session`, `diagnose_on_error`, `run`, `emit` |
| `diagnostics` | `NetworkLog` (method, redacted path, status, redacted headers; never bodies, tokens, cookies or query strings) and screenshot capture |
| `pdf` | `validate_pdf` and `html_to_pdf` (prints sanitised HTML in a throwaway headless browser) |
| `files` | `write_private_atomic` (mode 0600, all or nothing, refuses to overwrite by default) and `safe_component` |
| `months` | `MONTHS`, `parse_month` (`March`, `mar`, `3`) |

## Exit codes

| Code | Class | Meaning | What the skill does |
| ---- | ----- | ------- | ------------------- |
| 0 | | Success; one JSON document on stdout | Verify the file |
| 2 | | Bad arguments (argparse) | Fix the command |
| 3 | `NotLoggedInError`, `LoginTimeoutError` | No usable session | Ask the user to run `! <tool> login` |
| 4 | `ProfileBusyError` | Another run, or a stray Chromium, holds the profile | Wait and retry; never delete lock files |
| 5 | `ContractChangedError` | The site's pages or API changed shape | Report with diagnostics; update the skill's references and `contract.py` |
| 6 | `NotFoundError` | Nothing matches; `details` lists what exists | Show the options, ask the user |
| 7 | `PdfInvalidError` | The document was not a plausible PDF; nothing saved | Report with diagnostics |
| 8 | `ShutdownUnconfirmedError` | Chromium may still be running on the profile | Ask the user to quit it |
| 9 | `ApiError` | Unexpected status, or the network failed | Retry once, then report |
| 10 | `OutputExistsError` | The output file exists | Ask; re-run with `--overwrite` only if told to |

Errors are JSON on stderr. For 5, 7 and 9 the tool writes redacted diagnostics
under `~/.<tool>/diagnostics/` and lists them in `details.diagnostics`.

## Building a new browser skill

1. Copy the layout of `skills/three-phone-bill-download-petems/three-bill/`:
   `pyproject.toml`, `<pkg>/{__init__,__main__,contract,<site>,login,cli}.py`,
   `tests/`, `README.md`.
2. Depend on this package by git URL, pinned to a tag:

   ```toml
   dependencies = [
       "skill-browser @ git+https://github.com/petems/petems-skills@skill-browser-v0.1.0#subdirectory=packages/skill-browser",
   ]
   ```

3. Add the CLI's directory to `members` in the repo-root `pyproject.toml`.
   Inside the repo, that workspace overrides the git URL with this local copy.
4. Put every site fact (URLs, response shapes, identifier formats) in pure,
   unit-tested functions in `contract.py`, and document them in the skill's
   `references/`. The site module only moves bytes between the browser and
   `contract.py`.
5. Test end to end against a local `ThreadingHTTPServer` fake of the site
   (mark those tests `browser`). Never load the real site in tests.
6. In `SKILL.md`, allow only `Bash` and `Read`, run the CLI, and branch on the
   exit codes above.

## Releasing

Standalone skill installs (`npx skills add petems/petems-skills@<skill>`)
fetch this package from GitHub at the pinned tag. Tags are created by the
[`Tag skill-browser`](../../.github/workflows/tag-skill-browser.yml) workflow:

1. In the PR that changes this package, bump `version` in this
   `pyproject.toml` and `__version__` in `skill_browser/__init__.py`
   (`X.Y.Z`; the workflow fails if they differ).
2. Merge it. The workflow sees `pyproject.toml` change on `master` and pushes
   `skill-browser-v<version>` on the merge commit. A pyproject change without
   a version bump creates no tag.
3. Bump the tag in each CLI's dependency line when it needs the new version
   (after the tag exists, or a standalone install of that CLI will fail).

To re-run it by hand, use **Actions > Tag skill-browser > Run workflow** on
`master`.

## Develop

From the repo root:

```bash
uv run --package skill-browser --group dev pytest packages/skill-browser
```

The `browser` tests launch a real headless Chromium against local pages only.
