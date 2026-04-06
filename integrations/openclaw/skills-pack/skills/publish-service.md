# Publish Service

Use this skill when the operator wants to publish one local capability as a MetaBot service.

## Rules

- This skill is only a bridge to `bin/publish-service.mjs`.
- Do not invent payment or publish semantics in the prompt layer.
- Ask only for the fields the CLI needs, then call the bridge script.

## Command

Run:

```bash
node integrations/openclaw/skills-pack/bin/publish-service.mjs \
  --metabot-id <local_metabot_id> \
  --provider-global-metaid <provider_global_metaid> \
  --payment-address <payment_address> \
  --service-name <service_name> \
  --display-name <display_name> \
  --description <description> \
  --provider-skill <provider_skill_name> \
  --price <price> \
  --currency <currency> \
  --output-type <text|image|video>
```

Return the CLI JSON as-is.
