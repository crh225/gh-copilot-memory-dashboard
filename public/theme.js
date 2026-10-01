const themeKey = "copilot-memory-theme";
try {
  if (localStorage.getItem(themeKey) === "dark") document.documentElement.dataset.theme = "dark";
} catch (error) {
  console.warn("Theme preference storage is unavailable:", error.name);
}

function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === "dark";
  const button = document.getElementById("theme-toggle");
  button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  button.title = button.getAttribute("aria-label");
  button.setAttribute("aria-pressed", String(dark));
}

document.addEventListener("DOMContentLoaded", () => {
  updateThemeButton();
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    updateThemeButton();
    try {
      localStorage.setItem(themeKey, theme);
    } catch (error) {
      console.warn("Theme preference could not be saved:", error.name);
      const notice = document.getElementById("theme-status");
      notice.textContent = "Theme changed for this visit. Browser storage is unavailable, so the preference could not be saved.";
      notice.hidden = false;
    }
  });
});
