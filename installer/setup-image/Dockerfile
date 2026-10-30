# The setup image: the container the Windows installer runs the shell
# installer in, and the state commands read and write the aman_home
# volume through.
#
# It starts from the pinned Docker CLI image the state commands used
# before, which already carries the Docker CLI, the Compose and Buildx
# plugins, git and the BusyBox tools. What it does not carry is bash:
# its only shell is the BusyBox one, and installer/install.sh starts
# with "#!/usr/bin/env bash", so every container install and upgrade
# died at that first line with "env: can't execute 'bash'". The packages
# below are the full set the shell installer (installer/install.sh and
# installer/lib/*.sh) calls that the base image lacks, traced call by
# call: bash itself; python3, the port bind test in lib/ports.sh and
# the email sign-in check in lib/email.sh; curl, the download and
# health checks in lib/sandbox.sh and lib/edge.sh; ip, the address
# listing in lib/network.sh; and getconf and getent, called by
# lib/instance.sh and lib/edge.sh, which Alpine ships in libc-utils.
# Everything else the scripts call is a bash builtin, a script function,
# or a tool the base image already has. smoke.sh checks this list
# against the built image, so a base change that drops a tool fails
# here instead of on a person's computer.
#
# The digest below is the base image pin. It is also the pin
# installer/release.json carried as setup_image before this image
# existed; the two are not read from each other, so when the base is
# bumped, bump it here and republish.
FROM docker:cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb

RUN apk add --no-cache \
      bash \
      curl \
      iproute2 \
      libc-utils \
      python3
