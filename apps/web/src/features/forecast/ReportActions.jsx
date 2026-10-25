import { apiFetch } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Download } from "lucide-react";
import { buildSummaryReportHtml } from "./summaryReport.js";

export function ReportActions() {
  const { t } = useLanguage();
  async function downloadSummaryPdf() {
    const response = await apiFetch("/reports/executive-summary");
    const data = await response.json();
    const node = document.createElement("section");
    node.className = "pdf-report";
    node.innerHTML = buildSummaryReportHtml(data);
    try {
      const { default: html2pdf } = await import("html2pdf.js");
      await html2pdf()
        .set({
          margin: 12,
          filename: "pythia-executive-summary.pdf",
          image: { type: "jpeg", quality: 0.98 },
          html2canvas: { scale: 2 },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        })
        .from(node)
        .save();
    } catch {
      const blob = new Blob([data.summary], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "pythia-executive-summary.txt";
      link.click();
      URL.revokeObjectURL(url);
    }
  }

  return (
    <button
      className="primary-button"
      onClick={downloadSummaryPdf}
      style={{
        width: "auto",
        minHeight: "38px",
        height: "38px",
        padding: "0 18px",
        fontSize: "13px",
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        whiteSpace: "nowrap",
      }}
    >
      <Download size={15} /> {t("btn_export_pdf")}
    </button>
  );
}
