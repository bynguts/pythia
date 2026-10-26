import { useRef, useState } from "react";
import { Send } from "lucide-react";
import { apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { Drawer } from "../../shared/ui/Drawer.jsx";

/**
 * "New instruction": one free-text instruction to a truck's driver app (POST /api/dispatch).
 * @param {{ open: boolean, onClose: () => void, truckCodes: string[], role: string|null }} props
 */
export function InstructionDrawer({ open, onClose, truckCodes, role }) {
  const { t } = useLanguage();
  const [truck, setTruck] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState({ busy: false, sent: null, error: null });
  const chosen = truck || truckCodes[0] || "";
  // A double tap lands before the busy state renders; the ref keeps it to one dispatch.
  const sending = useRef(false);

  async function submit(event) {
    event.preventDefault();
    if (!chosen || !text.trim() || sending.current) return;
    sending.current = true;
    setStatus({ busy: true, sent: null, error: null });
    try {
      await apiPost("/dispatch", {
        truck_code: chosen,
        instruction: text.trim(),
        manager_id: role || "dispatcher",
      });
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
            data-testid="instruction-truck"
          >
            {truckCodes.map((code) => (
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
        {status.error && (
          <p className="ops-form-note is-error" role="alert">
            {status.error}
          </p>
        )}
      </form>
    </Drawer>
  );
}
