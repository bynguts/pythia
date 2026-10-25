// What each role may do, for the read-only "Tim & akses" section. Mirrors ROLES in
// apps/api/app/core/auth.py (tests/api/test_settings_roles_mirror.py keeps them equal);
// the server enforces the real permissions, this map only describes them.
export const ROLE_PERMISSIONS = {
  administrator: [
    "dashboard:read",
    "reports:read",
    "history:read",
    "operations:plan",
    "operations:approve",
    "dispatch:create",
    "dispatch:confirm",
    "provenance:read",
    "admin:manage",
    "spj:override",
  ],
  supervisor: [
    "dashboard:read",
    "dispatch:create",
    "dispatch:confirm",
    "operations:approve",
    "history:read",
    "spj:override",
  ],
  dispatcher: ["dashboard:read", "operations:plan", "dispatch:create", "history:read"],
  executive: ["dashboard:read", "reports:read", "history:read"],
  auditor: ["history:read", "reports:read", "provenance:read"],
  driver: ["dispatch:confirm"],
};
