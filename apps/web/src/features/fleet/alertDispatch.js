import { apiFetch } from "../../shared/api/client.js";

export function createAlertDispatch(alert, t, issue) {
  const route = alert.recommended_routes?.[0];
  const instruction = route
    ? `${t("ac_instruction_route")} ${route.name}. ${t("ac_instruction_confirm")}`
    : `${t("ac_instruction_handle")}: ${issue || alert.description || alert.title}`;
  return apiFetch("/dispatch", {
    method: "POST",
    body: {
      truck_code: alert.truck_code,
      instruction,
      manager_id: localStorage.getItem("pythia_role") || "manager_central",
    },
  });
}
