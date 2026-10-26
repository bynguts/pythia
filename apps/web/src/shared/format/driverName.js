// The simulated fleet's drivers are named "Pengemudi Sim NN" by the API. On screen they
// read "Driver 19" / "Pengemudi 19"; the result says they are simulated so the caller
// sets data-provenance="simulated" and a title (thin honesty labels).
const SIMULATED = /^Pengemudi Sim\s+0*(\d+)$/i;

/**
 * @param {string|null|undefined} name  driver_name from the API
 * @param {(key: string) => string} t   useLanguage().t
 * @returns {{ label: string, number: string|null, simulated: boolean, title: string|undefined }}
 *   label: display name ("—" when missing); number: "19" for simulated drivers (avatar);
 *   title: tooltip for simulated drivers.
 */
export function formatDriverName(name, t) {
  if (!name) return { label: "—", number: null, simulated: false, title: undefined };
  const match = String(name).trim().match(SIMULATED);
  if (!match) return { label: name, number: null, simulated: false, title: undefined };
  return {
    label: t("f_driver_n").replace("{n}", match[1]),
    number: match[1],
    simulated: true,
    title: t("f_driver_simulated"),
  };
}
