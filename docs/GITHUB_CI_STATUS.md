# GitHub CI status

## Prepared

This directory is a complete repository tree for a private `EsmailELBoBDev2/CairoDrive` repository.

Workflow: `.github/workflows/build.yml`

Expected artifact name: `CairoDrive-v22.3-signed-com.cairodrive.app`.

Expected signed outputs:

- `CairoDrive-v22.3.apk`
- `CairoDrive-v22.3.aab`
- `CairoDrive-v22.3-universal.apk`
- `CairoDrive-v22.3-patcher-source.zip`
- `BUILD_REPORT.txt`
- `VERIFY_OUTPUT.txt`
- `SHA256SUMS.txt`

## Repository creation limitation in this ChatGPT session

The connected GitHub account is authenticated, but the available connector actions do not expose repository creation and currently return zero accessible repositories for the account. Therefore this session cannot truthfully claim that a GitHub repository was created or that Actions ran.

`CREATE_PRIVATE_REPO.sh` performs the missing bootstrap locally with authenticated GitHub CLI. Once the private repository exists, `SET_GITHUB_SECRETS.sh` and `UPLOAD_BASE_APK_PRIVATE_RELEASE.sh` complete the private CI inputs.

## Base APK

The original third-party APK is not part of normal Git history. `UPLOAD_BASE_APK_PRIVATE_RELEASE.sh` uploads the user's own local copy as a **private Release asset**, records the full APK SHA-256 in Actions secrets, and CI also refuses any APK whose target `libapp.so` hash does not match the exact supported binary.
