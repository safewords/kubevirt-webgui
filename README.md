# The kubevirt-webgui Helm repository

This branch is a Helm chart repository, published by `.github/workflows/chart.yml`
on the `main` branch. Chart packages are attached to GitHub releases named
`chart-<name>-<version>`; `index.yaml` points at them.

    helm repo add kubevirt-webgui https://raw.githubusercontent.com/safewords/kubevirt-webgui/gh-pages
    helm repo update
    helm install kubevirt-webgui kubevirt-webgui/kubevirt-webgui -n kubevirt-webgui --create-namespace

The same chart is published as an OCI artifact, which needs no repository at all:

    helm install kubevirt-webgui oci://ghcr.io/safewords/charts/kubevirt-webgui -n kubevirt-webgui --create-namespace

Nothing here is edited by hand.
