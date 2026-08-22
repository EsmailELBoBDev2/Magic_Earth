# CairoDrive v24.2 Final Audit Patch

Incremental patch for a repository that already has `v24.0-google-free-traffic` applied.

```bash
bash ./cairodrive-v24.2-final-audit/apply.sh "$PWD"
./verify_patcher.sh
./VERIFY_REPO.sh
git diff --check
```

Expected final markers:
- `APPLY V24.2: PASS`
- `v24.2 ... verification: PASS`
- `VERIFY_REPO: PASS`

After building/installing, provision keys with `./provision_api_keys.sh`; it uses hidden prompts when environment variables are not supplied.
