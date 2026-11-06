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

## Build, check, publish

You need Docker running, and, to publish, a Docker sign-in to ghcr.io
that can write packages for ClimbOutLabs.

    installer/setup-image/publish.sh

builds the image and runs the smoke check (smoke.sh) against it. The
check executes installer/install.sh --help inside the image, the same
way the Windows installer executes it, and confirms every tool the
shell installer calls is present. Nothing is pushed.

    installer/setup-image/publish.sh --publish

also pushes ghcr.io/climboutlabs/aman-setup, checks the pushed image,
and prints the pin line. Paste that line over the setup_image line in
installer/release.json, and the same reference over the old one in
packages/aman-installer/tests/golden/install-commands.txt (three
lines). Until then, installer/release.json holds a placeholder digest
of zeros: the shape is the real one, but no image sits behind it, so
publish before merging any change that carries the placeholder.
