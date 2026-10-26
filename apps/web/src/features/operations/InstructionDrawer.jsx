import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { apiGet, apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { Drawer } from "../../shared/ui/Drawer.jsx";
import { StatusDot } from "../../shared/ui/StatusDot.jsx";

const ANSWER_POLL_MS = 5000;

/**
 * "New instruction": one free-text instruction to a truck's driver app (POST /api/dispatch).
 * After sending, the driver's answer (GET /api/dispatch/{id}/status) shows under the note.
 * @param {{ open: boolean, onClose: () => void, truckCodes: string[], role: string|null }} props
 */
export function InstructionDrawer({ open, onClose, truckCodes, role }) {
  const { t } = useLanguage();
  const [truck, setTruck] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState({ busy: false, sent: null, error: null });
  // The live fleet snapshot can take seconds after Operations opens: until it lands the
  // truck list comes from the fleet registry (GET /fleet), and the send waits for a truck.
  const [registry, setRegistry] = useState(null);
  const needRegistry = open && truckCodes.length === 0 && registry === null;
  useEffect(() => {
    if (!needRegistry) return undefined;
    const controller = new AbortController();
    apiGet("/fleet", { signal: controller.signal })
      .then((body) => {
        const list = Array.isArray(body) ? body : body?.trucks || [];
        setRegistry(
          list
            .map((item) => item?.truck_code)
            .filter(Boolean)
            .sort(),
        );
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setRegistry([]);
      });
    return () => controller.abort();
  }, [needRegistry]);
  const codes = truckCodes.length > 0 ? truckCodes : registry || [];
  const loadingTrucks = codes.length === 0 && registry === null;
  const chosen = codes.includes(truck) ? truck : codes[0] || "";
  // A double tap lands before the busy state renders; the ref keeps it to one dispatch.
  const sending = useRef(false);
  // The last instruction sent from here and the driver's answer to it.
  const [answer, setAnswer] = useState(null);

  useEffect(() => {
    if (!open || !answer?.id || answer.status !== "PENDING") return undefined;
    const poll = () =>
      apiGet(`/dispatch/${encodeURIComponent(answer.id)}/status`)
        .then((dispatch) => {
          const fieldStatus = String(dispatch?.field_status || "PENDING").toUpperCase();
          if (fieldStatus !== "PENDING")
            setAnswer({ id: answer.id, status: fieldStatus, note: dispatch.confirmed_note || "" });
        })
        .catch(() => {}); // keep "no answer yet" until a poll reads one
    poll();
    const timer = setInterval(poll, ANSWER_POLL_MS);
    return () => clearInterval(timer);
  }, [open, answer]);

  async function submit(event) {
    event.preventDefault();
    if (!chosen || !text.trim() || sending.current) return;
    sending.current = true;
    setStatus({ busy: true, sent: null, error: null });
    try {
      const dispatch = await apiPost("/dispatch", {
        truck_code: chosen,
        instruction: text.trim(),
        manager_id: role || "dispatcher",
      });
      setAnswer(dispatch?.id ? { id: dispatch.id, status: "PENDING", note: "" } : null);
      setText("");
      setStatus({ busy: false, sent: chosen, error: null });
    } catch (error) {
      setStatus({
        busy: false,
        sent: null,
        error: t(error?.status === 403 ? "s1_err_denied" : "s1_err_failed"),
      });
    } finally {
      sending.current = false;
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("s1_new_instruction")}
      subtitle={t("s1_instruction_sub")}
      initialFocus="#ops-instruction-truck"
      testId="instruction-drawer"
    >
      <form className="ops-form" onSubmit={submit}>
        <label className="ops-field">
          <span>{t("s1_instruction_truck")}</span>
          <select
            id="ops-instruction-truck"
            value={chosen}
            onChange={(event) => setTruck(event.target.value)}
            disabled={codes.length === 0}
            aria-busy={loadingTrucks || undefined}
            data-testid="instruction-truck"
          >
            {codes.length === 0 && (
              <option value="">
                {t(loadingTrucks ? "s1_instruction_trucks_loading" : "s1_instruction_no_trucks")}
              </option>
            )}
            {codes.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label className="ops-field">
          <span>{t("s1_instruction_text")}</span>
          <textarea
            rows={4}
            maxLength={500}
            value={text}
            placeholder={t("s1_instruction_placeholder")}
            onChange={(event) => setText(event.target.value)}
            data-testid="instruction-text"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          icon={Send}
          disabled={status.busy || !chosen || !text.trim()}
          data-testid="instruction-send"
        >
          {t("s1_instruction_send")}
        </Button>
        {status.sent && (
          <p className="ops-form-note" role="status">
            {t("s1_instruction_sent").replace("{truck}", status.sent)}
          </p>
        )}
        {status.sent && answer && (
          <StatusDot
            tone={answer.status === "READY" ? "ok" : answer.status === "PENDING" ? "idle" : "warn"}
            data-testid="instruction-driver-answer"
            data-status={answer.status}
          >
            {answer.status === "READY"
              ? t("s1_instruction_driver_ready")
              : answer.status === "PENDING"
                ? t("s1_instruction_driver_waiting")
                : answer.note
                  ? t("s1_instruction_driver_issue").replace("{reason}", answer.note)
                  : t("s1_instruction_driver_issue_plain")}
          </StatusDot>
        )}
        {status.error && (
          <p className="ops-form-note is-error" role="alert">
            {status.error}
          </p>
        )}
      </form>
    </Drawer>
  );
}
