{{/* The chart name, overridable. */}}
{{- define "kubevirt-webgui.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The release's resource name. */}}
{{- define "kubevirt-webgui.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "kubevirt-webgui.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kubevirt-webgui.labels" -}}
helm.sh/chart: {{ include "kubevirt-webgui.chart" . }}
{{ include "kubevirt-webgui.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kubevirt-webgui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kubevirt-webgui.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kubevirt-webgui.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kubevirt-webgui.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The Secret holding APP_KEY: the one given, or the one this chart keeps. */}}
{{- define "kubevirt-webgui.keySecretName" -}}
{{- if .Values.appKey.existingSecret -}}
{{- .Values.appKey.existingSecret -}}
{{- else -}}
{{- printf "%s-key" (include "kubevirt-webgui.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
The application key, base64 of exactly 32 bytes as the framework requires.

Read back from the cluster when it is already there, so an upgrade does not
mint a new one and sign every open session out. `lookup` returns nothing during
`helm template` and on a dry run, which is why a rendered manifest shows a key
that is not the live one.
*/}}
{{- define "kubevirt-webgui.appKey" -}}
{{- $name := printf "%s-key" (include "kubevirt-webgui.fullname" .) -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $name -}}
{{- if and $existing $existing.data (index $existing.data "APP_KEY") -}}
{{- index $existing.data "APP_KEY" -}}
{{- else -}}
{{- printf "base64:%s" (randBytes 32) | b64enc -}}
{{- end -}}
{{- end -}}
