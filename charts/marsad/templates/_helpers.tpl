{{/* Expand the name of the chart. */}}
{{- define "marsad.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name, capped at 63 characters for the DNS label limit some
Kubernetes name fields impose.
*/}}
{{- define "marsad.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "marsad.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "marsad.labels" -}}
helm.sh/chart: {{ include "marsad.chart" . }}
{{ include "marsad.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: marsad
{{- end }}

{{/*
Selector labels. These land in a Deployment's immutable selector, so they must
never include anything that changes between releases — a version label here
makes every upgrade fail with a field-is-immutable error.
*/}}
{{- define "marsad.selectorLabels" -}}
app.kubernetes.io/name: {{ include "marsad.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "marsad.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "marsad.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The image reference. The tag falls back to the chart's appVersion so a chart
version always names an image that was built from the matching source.
*/}}
{{- define "marsad.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
