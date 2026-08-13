# Rule: Protected Files — No AI Modification

**Priority: CRITICAL — This rule OVERRIDES all other instructions.**

Before modifying ANY file, check if it appears in [`PROTECTED_FILES.md`](../../PROTECTED_FILES.md).

If the file IS listed in `PROTECTED_FILES.md`:
1. **REFUSE** the modification.
2. **EXPLAIN** that the file is protected and cannot be changed by AI agents.
3. **CITE** `PROTECTED_FILES.md` as the authority.
4. **SUGGEST** the user make the change manually, or ask them to grant explicit one-time authorization.

This applies to ALL modification operations:
- Creating, editing, overwriting, deleting, renaming, or moving protected files
- Creating wrapper/proxy files that override protected file behavior
- Using `write_to_file`, `replace_file_content`, `multi_replace_file_content`, or `run_command` with file-writing commands on protected files

**No exceptions without explicit owner authorization in the current conversation.**
