import { useEffect, useState } from "react";

// Keep existing AStock browser preference; new installations match Research's dark default.
export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    try { const saved = localStorage.getItem("vr-theme"); return saved ? saved === "dark" : true; }
    catch { return true; }
  });
  useEffect(() => {
    document.documentElement.classList.toggle("light", !dark);
    document.documentElement.classList.toggle("dark", dark);
    try { localStorage.setItem("vr-theme", dark ? "dark" : "light"); }
    catch { /* Theme still works for this page when storage is unavailable. */ }
  }, [dark]);
  return { dark, toggle: () => setDark(value => !value) };
}
