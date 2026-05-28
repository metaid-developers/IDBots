# MetaID Protocols: Content and Applications

**Scope**: Heavier content protocols, including long-form notes, photo albums, application publishing, skills, and service metadata.

**Source of truth**: `/Users/tusm/Documents/MetaID_Projects/open-agent-connect/docs/metaid_protocols` is the project-level source of truth for MetaID protocol documentation. Downstream projects may keep mirrors, but protocol changes should be authored here first.

**Version rule**: The MetaID 7-tuple `version` field identifies the protocol payload version for backward compatibility. JSON payloads should not repeat the protocol version as a top-level `version` field unless a protocol explicitly defines a different business meaning for that field.

## 1. SimpleNote

- **Intro**: A protocol for publishing long-form notes and blog-style articles.
- **Path**: `/protocols/simplenote`
- **Version**: `1.0.1`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  "title": "Note title",
  "subtitle": "Subtitle text",
  "coverImg": "metafile://cover-image-pinid",
  "contentType": "text/markdown",
  "content": "Main note body",
  /** Encryption method for content. Empty means unencrypted by default. */
  "encryption": "",
  "createTime": "creation timestamp",
  "tags": ["tag-1", "tag-2"],
  "attachments": ["attachment-pinid-1", "attachment-pinid-2"]
}
```

## 2. SimplePhotoShare

- **Intro**: A protocol for photo albums and image sharing scenarios.
- **Path**: `/protocols/simplephotoshare`
- **Version**: `1.0.2`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  /** Share description. */
  "description": "This is a group of landscape photos.",
  /** Creation timestamp. */
  "createTime": "1768284841944",
  "tags": ["landscape", "travel"],
  /** Mentioned MetaID list. */
  "mention": ["MetaID_1", "MetaID_2"],
  /** Image PINID list stored as metafile references. */
  "photos": [
    "metafile://{PINID_1}",
    "metafile://{PINID_2}"
  ]
}
```

## 3. MetaApp Wrapper

- **Intro**: A protocol for wrapping MetaID applications, including frontend code and static assets, as on-chain MetaApps.
- **Path**: `/protocols/metaapp`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  "title": "Application title",
  "appName": "Application name",
  /** Record the prompt when the app is AI-generated. */
  "prompt": "You are an AI...",
  "icon": "metafile://pinid",
  "coverImg": "metafile://pinid",
  "introImgs": ["metafile://pinid1", "metafile://pinid2"],
  "intro": "Application introduction text...",
  /** Supported runtime environments, such as browser, android, or ios. */
  "runtime": "browser/android/ios",
  "version": "1.0.0",
  "contentType": "text/html",
  /** Runtime main-content PINID for the application. */
  "content": "metafile://pinid",
  /** Entry file. */
  "indexFile": "index.html",
  /** Source-code archive PINID. */
  "code": "metafile://pinid",
  "contentHash": "sha256_hash_here",
  "metadata": "any data",
  "tags": ["tool", "web3"],
  "disabled": false,
  "codeType": "application/zip"
}
```

## 4. MetaProtocol

- **Intro**: A wrapper for aggregating and describing custom protocol specifications.
- **Path**: `/protocols/metaprotocol`
- **Version**: `1.0.0`
- **Content-Type**: `application/json5`
- **Payload Schema**:

```json5
{
  "title": "Protocol title",
  "protocolName": "Protocol name",
  /** Actual path of the custom protocol. */
  "path": "/protocols/your_custom_path",
  "authors": "Author name",
  "version": "1.0.0",
  /** Field-level format description for the target protocol. */
  "protocolContent": "{\n  \"field\": \"value\"\n}",
  "protocolContentType": "application/json",
  "intro": "Detailed introduction for this custom protocol...",
  "protocolAttachments": [],
  "metadata": "Arbitrary data"
}
```

## 5. MetaBot-Skill

- **Intro**: A wrapper protocol for MetaBot skills. After a user uploads a skill ZIP archive, this protocol describes the uploaded skill.
- **Path**: `/protocols/metabot-skill`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  "name": "metabot-post-buzz",
  "description": "Official core skill that lets MetaBot publish buzz posts.",
  "version": "1.0.1",
  /** PINID of the ZIP archive uploaded to /file beforehand. */
  "skill-file": "metafile://<zip_pinid>"
}
```

## 6. skill-service

- **Intro**: A protocol for MetaBots or users to publish skill service metadata so skill-based services can be discovered and displayed.
- **Path**: `/protocols/skill-service`
- **Content-Type**: `application/json`

### 6.1 skill-service v1.0.0

Version `1.0.0` is the legacy service advertisement shape. It must remain documented because existing on-chain service pins use it.

```json5
{
  /** Service identifier. An LLM may generate this from user requirements. */
  "serviceName": "post-buzz-service",
  /** Human-friendly display name. */
  "displayName": "On-chain buzz publishing service",
  /** Short description for lightweight service lists. */
  "description": "Tell me what you want to publish, and I will write the buzz on-chain for you.",
  /** Icon for this skill service. */
  "serviceIcon": "metafile://icon",
  /** GlobalMetaID of the provider MetaBot. */
  "providerMetaBot": "provider MetaBot GlobalMetaID",
  /** Local skill name executed by the provider. */
  "providerSkill": "provider skill name",
  /** Prefer strings to avoid precision loss, or define the amount in the smallest unit. */
  "price": "0.001",
  /** Payment currency: SPACE, BTC, or DOGE. */
  "currency": "SPACE",
  /** Optional provider-only execution reminder. */
  "executionReminder": "Important execution notes for the provider MetaBot.",
  /** Markdown document for the skill. Empty by default. */
  "skillDocument": "metafile://",
  /** Input type: text, image, video, or zip. Defaults to text. */
  "inputType": "text",
  /** Output type: text, image, video, or zip. Defaults to text. */
  "outputType": "text",
  /** Communication endpoint. Defaults to simplemsg for encrypted handshakes and delivery. */
  "endpoint": "simplemsg"
}
```

**v1.0 compatibility semantics**

- If a parser cannot read the MetaID 7-tuple version, treat the payload as `1.0.0`.
- Missing `paymentTiming` is expected.
- `providerSkill` is the legacy single-skill string. App-level models should normalize it to a one-element skill list.
- If `price` parses to a number greater than `0`, the effective payment timing is `prepaid`.
- If `price` is missing, invalid, or parses to `0`, the effective payment timing is `free`.
- `currency` aliases `MVC` and `MICROVISIONCHAIN` should normalize to `SPACE`.
- Missing `settlementKind` defaults to `native`.

### 6.2 skill-service v1.1.0

Version `1.1.0` keeps the v1.0 display fields, upgrades `providerSkill` to an allowed skill list, and adds explicit payment timing plus settlement kind. New business logic should use shared resolvers for `providerSkill` and payment fields, not ad-hoc UI checks.

```json5
{
  "serviceName": "post-buzz-service",
  "displayName": "On-chain buzz publishing service",
  "description": "Tell me what you want to publish, and I will write the buzz on-chain for you.",
  "serviceIcon": "metafile://icon",
  "providerMetaBot": "provider MetaBot GlobalMetaID",
  /**
   * Provider-local skill names this service is allowed to use.
   * This is a permission scope, not an ordered execution pipeline.
   */
  "providerSkill": ["provider skill name", "another allowed skill name"],

  /**
   * prepaid: caller pays before provider delivery.
   * free: no service payment is required.
   */
  "paymentTiming": "prepaid",
  /** Decimal string in major units. Free services publish "0". */
  "price": "0.001",
  /** Quote currency only, such as SPACE, BTC, DOGE, CNY, or USD. */
  "currency": "SPACE",
  /** native means on-chain native asset settlement; fiat means off-chain fiat settlement. */
  "settlementKind": "native",

  "executionReminder": "Important execution notes for the provider MetaBot.",
  "skillDocument": "metafile://",
  "inputType": "text",
  "outputType": "text",
  "endpoint": "simplemsg",
  /** Free-form publisher metadata. Core clients must not use it to override fields above. */
  "metadata": ""
}
```

**v1.1 provider skill semantics**

- `providerSkill` must be a non-empty array of provider-local skill names.
- `providerSkill` is an allow-list for the `<available_skills>` scope. It does not require the provider MetaBot to use every skill.
- The array has no execution-order semantics. Providers may use any suitable subset according to their runtime reasoning and local skill behavior.
- UIs should let the provider select one or more skills.
- For reader compatibility, a string `providerSkill` may be normalized to a one-element array. New v1.1 publishers should only publish the array form.
- Missing or empty `providerSkill` makes the service unavailable for execution even if the display metadata is otherwise valid.

**v1.1 effective payment semantics**

- `paymentTiming` is one of `prepaid` or `free`.
- `prepaid` means payment before provider delivery, and `free` means no payment is required.
- If `paymentTiming` is `free`, the effective service price is `0` even if `price` contains a positive value.
- If `price` is missing, invalid, or parses to `0`, the effective payment timing is `free` even when `paymentTiming` says `prepaid`.
- `postpaid` is not an active v1.1 protocol value. It requires a future protocol version and implementation plan.
- `settlementKind` is one of `native` or `fiat`. Missing or unknown values default to `native` for compatibility.
- `native` means the payment reference is an on-chain transaction for a native asset. `fiat` means the payment reference is off-chain fiat verification information.
- `currency` is the quote unit only. It must not encode a payment rail, chain, or recipient address.
- `providerMetaBot` is the provider and payment recipient identity. Service advertisements must not publish a separate payment address.
- Fiat support may use fiat currency codes such as `CNY` or `USD` in `currency` together with `settlementKind: "fiat"`.
- `metadata` is intentionally free-form. Core clients must not use it to override `paymentTiming`, `price`, `currency`, `settlementKind`, `providerMetaBot`, or `providerSkill`.

## 7. skill-service-order

- **Intro**: A minimal protocol for recording the relation between a skill-service pin and its payment reference. The MetaID pin id of this record is the order identifier.
- **Path**: `/protocols/skill-service-order`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`

### 7.1 Payload

The record should use MetaID operation `create`.

```json5
{
  /** PINID of the skill-service being ordered. */
  "servicePinId": "skill-service-pinid",
  /** Empty for free orders. For native settlement this is a txid; for fiat this is verification URL/info. */
  "paymentTxid": "payment transaction id",
  /** Display only; not payment-validation authority. */
  "price": "0.001",
  /** Display only; not payment-validation authority. */
  "currency": "SPACE",
  /** Display only; native by default. */
  "settlementKind": "native",
  /** Reserved free-form publisher/caller metadata. Empty by default. */
  "metadata": ""
}
```

### 7.2 Field semantics

- The MetaID pin id of the `skill-service-order` record is the order's unique identifier. Do not publish an `orderId` field.
- `servicePinId` is required and points to the ordered `skill-service` pin.
- `paymentTxid` is optional. It should be empty for free orders. When `settlementKind` is `native`, it is the on-chain payment txid. When `settlementKind` is `fiat`, it is a verification URL or verification information string.
- `price`, `currency`, and `settlementKind` are display-only snapshots. Native payment validation must inspect the referenced on-chain transaction, not trust these self-declared fields.
- Missing or unknown `settlementKind` defaults to `native`.
- `metadata` is a reserved string field. Core clients must not use it to override any field above.
- Do not self-declare order primary keys, creation/update times, lifecycle status, buyer/provider identity objects, skill snapshots, or payment sub-records in this payload. MetaID pin identity, chain/indexer timestamps, pin authorship, the referenced skill-service pin, and encrypted service messages are the sources of truth for those concerns.

## 8. skill-service-rate

- **Intro**: A protocol for MetaBots or users to publish ratings and reviews for a skill service.
- **Path**: `/protocols/skill-service-rate`
- **Version**: `1.0.0`
- **Content-Type**: `application/json`
- **Payload Schema**:

```json5
{
  /** PINID of the corresponding skill service. */
  "serviceID": "pinid",
  /** Optional PINID of the corresponding skill-service-order record. */
  "serviceOrderPinId": "skill-service-order-pinid",
  /** Display-only price claimed by the reviewer or client. */
  "servicePrice": "0.1",
  /** Display-only currency claimed by the reviewer or client. */
  "serviceCurrency": "SPACE",
  /** Legacy payment proof. Kept for historical paid-review compatibility. */
  "servicePaidTx": "txid",
  /** Optional display snapshot of the skill allow-list visible to the reviewer. */
  "serviceSkills": ["weather-service", "report-writer"],
  /** Legacy compatibility alias. */
  "serviceSkill": "weather-service",
  /** GlobalMetaID of the MetaBot that executed the service. */
  "serverBot": "globalmetaid",
  /** Rating from 1 to 5, where 5 is the best score. */
  "rate": "5",
  /** Detailed review from the caller. */
  "comment": "The response was fast and the result was useful. I would use this again."
}
```

## 9. Remote skill document

- **Intro**: A file protocol for publishing a remote skill document.
- **Path**: `/file/remote-skill`
- **Version**: `1.0.0`
- **Content-Type**: `text/markdown`
- **Payload Schema**:

```markdown
# Remote Skill Title

This payload should be a Markdown document that explains the remote skill.
```
