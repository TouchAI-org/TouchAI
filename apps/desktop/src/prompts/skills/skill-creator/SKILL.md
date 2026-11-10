---
name: skill-creator
description: Create or update reusable agent skills when the user asks to write a SKILL.md, package a repeatable workflow, or improve an existing skill.
metadata:
    short-description: Create and improve skills
---

# Skill Creator

Write concise, reusable instructions that preserve the user's intent. Include knowledge that changes how the agent performs the task; avoid generic advice, copied manuals, and permissions the user did not grant.

## Choose the destination

For a new skill, establish the user's explicit destination or sharing choice before creating its directory or writing any files. Asking from inside TouchAI, selecting this built-in skill, the current working directory, and a TouchAI-related workflow do not select a destination. There is no default scope.

If the user has not already chosen a destination for this skill, first use `builtin__ask_user_question` to offer these two choices. Use the user's language; for Chinese:

```json
{
    "questions": [
        {
            "header": "保存位置",
            "question": "这个技能要保存到应用还是全局？",
            "multiSelect": false,
            "allowOther": true,
            "options": [
                { "label": "应用", "description": "仅在 TouchAI 中使用" },
                {
                    "label": "全局",
                    "description": "保存到 .agents/skills，供支持该目录的其他应用共用"
                }
            ]
        }
    ]
}
```

Wait for the user's answer before installing. A skipped, cancelled, failed, or ambiguous answer is not a destination choice; do not silently choose either scope. If the question tool is unavailable, ask the same short question in conversation and wait for a reply. You may draft the skill content without writing files while the choice is pending.

Respect an explicit path or sharing preference already given for this skill; do not ask again. When updating an existing editable skill, keep its current directory unless the user asks to relocate it. A new customization of a built-in is a new skill and needs its own destination choice.

| User's explicit choice                              | Destination                                          |
| --------------------------------------------------- | ---------------------------------------------------- |
| 应用 / Application / only TouchAI / not shared      | `<TouchAI skills root>/<name>/SKILL.md`              |
| 全局 / Global / shared with other compatible agents | `<current user home>/.agents/skills/<name>/SKILL.md` |

Resolve the TouchAI skills root from this built-in skill's exact catalog path: remove the trailing `.system/skill-creator/SKILL.md` (using the host's path separators). The remaining `skills` directory is the editable application root. It may be on any drive; do not assume the application install directory or a fixed home path. Resolve the shared root from the current operating-system user's home. The shared directory is `.agents/skills`, not `.agent`.

Do not promise that every agent supports the shared location.

TouchAI discovers direct children of both roots. Put each skill immediately under the chosen root. `.system` and other hidden directories are managed by the application: never write user skills there or edit bundled skills in place. If asked to customize a built-in, create an editable skill with a distinct name. If the user requests a different directory, respect that path but explain that TouchAI currently does not discover arbitrary or project-local roots.

Creating a shared copy does not authorize deleting the original. Before replacing an unrelated existing directory, deleting a source copy, or changing sharing scope, check whether the user has already authorized that action; ask only when authorization is missing. Never copy credentials, machine-specific secrets, or private examples into a shared skill.

## Write the skill

1. Use the user's stated task and examples to identify the trigger, desired output, and essential constraints. Ask only for missing details that affect the result.
2. Choose a concise lowercase name using letters, digits, and single hyphens, at most 64 characters. Match the directory name to `name`; do not use separators, `..`, leading dots, or leading/trailing hyphens.
3. Create UTF-8 `SKILL.md` with YAML frontmatter containing `name` and a short `description` of what it does and when it applies. An optional `metadata.short-description` supplies compact UI copy. Quote YAML values when needed.
4. Keep the body focused on the workflow and decision criteria. Preserve existing useful instructions when editing. Use relative paths for supporting files.
5. Add `scripts/`, `references/`, or `assets/` only when they serve a concrete repeated need. Link relevant references from the body and load them only when needed. A simple skill needs only `SKILL.md`.

Example:

```markdown
---
name: meeting-notes
description: Turn meeting transcripts or notes into decisions and assigned follow-up actions.
metadata:
    short-description: Organize meeting notes
---

Use the provided meeting material to summarize discussion, confirmed decisions, and actions.
Distinguish decisions from proposals. For every action, include its owner and deadline;
mark missing information as “to confirm” instead of inventing it.
```

TouchAI currently uses the required fields and `metadata.short-description`. Do not claim that optional metadata, `agents/openai.yaml`, or pi-specific invocation settings enforce tool permissions or automatic-loading policy in TouchAI. Use the ordinary tools and approvals available in this session; a skill is guidance, not a permission grant. If no authorized filesystem-writing tool is available, provide the complete content and exact destination for manual saving, and say it has not been installed.

## Validate and hand back

Read back the saved file; check valid YAML, matching name/directory, useful routing description, resolved relative links, and no unfinished placeholders or secrets. Test any executable helpers. Try a representative task and a nearby request that should not invoke the skill. State which checks actually ran.

In TouchAI, refresh Settings → Skills and confirm the skill appears, then select it using `/name` or `$name`. Refresh does not grant permission to run the skill's tools. Same-name skills at different paths remain distinct; use a distinct name or the exact catalog path when needed.

Report the exact saved path, whether it is TouchAI-only or shared, and verification results. Do not claim installation or successful invocation without observing it.
