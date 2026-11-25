# Verifies that every executable under -Root carries a valid, timestamped
# Authenticode signature from the certificate with the given SHA-1 thumbprint.
#
# Used once per (PortableGit archive, certificate) by
# scripts/mingit-signed-cache.cjs before it trusts a signed tree enough to
# reuse it in later builds. Prints one JSON array to stdout:
#   [{ "path": "usr/bin/git.exe", "status": "Valid", "signer": "<THUMBPRINT>", "timestamped": true }, ...]
# Any file that is not Valid, signed by another certificate, or not
# timestamped makes the caller refuse to cache the tree: an undated signature
# dies with the certificate, and a cached tree would ship it forever.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Thumbprint
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$results = @()
foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File -Filter '*.exe') {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  $relative = $file.FullName.Substring($Root.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
  $results += [pscustomobject]@{
    path = $relative
    status = [string]$signature.Status
    signer = $(if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null })
    timestamped = [bool]$signature.TimeStamperCertificate
  }
}

# -Compress keeps the output on one line; wrap in an array so a single result
# still serializes as JSON array syntax.
, $results | ConvertTo-Json -Compress
