# The setup image

The Windows installer does its work inside one container, the setup
image: the state commands read and write the aman_home volume through
it, and install, upgrade, backup and network changes run the shell
installer (installer/install.sh) in it.

The image used to be Docker's pinned CLI image. That image has no
bash, and the shell installer is a bash script, so every container
install died at the script's first line. This folder builds our own
setup image instead: the same pinned CLI image as the base, plus bash
and the few other tools the shell installer calls that the base lacks.
The Dockerfile comments carry the traced list.

## Build and check

With Docker running:

    pnpm build:setup-image
    pnpm test:setup-image aman-setup:local

The check runs installer/install.sh --help inside the image, the same
way the Windows installer runs it, and confirms every tool the shell
installer calls is there. CI runs the same build and check on every
pull request that touches the installer, on x64 and arm64, and checks
the image installer/release.json pins as well.

## Publish

The Setup image workflow publishes the image when a change to this
folder reaches main: it builds it for x64 and arm64, pushes
ghcr.io/climboutlabs/aman-setup, pulls the pushed image back without
signing in, checks it, and prints the pin line in the run summary.
Put that line in place of the setup_image line in installer/release.json
in a pull request; CI checks the pinned image before it can merge.
