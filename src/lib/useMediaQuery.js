import { getCurrentScope, onScopeDispose, ref } from "vue";

/**
 * Track whether a CSS media query matches. Without a browser window it never
 * matches.
 * @param {string} query
 */
export function useMediaQuery(query) {
  const matches = ref(false);
  if (typeof window === "undefined" || !window.matchMedia) return matches;

  const mediaQueryList = window.matchMedia(query);
  matches.value = mediaQueryList.matches;

  /** @param {{ matches: boolean }} event */
  const handleChange = (event) => {
    matches.value = event.matches;
  };
  mediaQueryList.addEventListener("change", handleChange);

  if (getCurrentScope()) {
    onScopeDispose(() => {
      mediaQueryList.removeEventListener("change", handleChange);
    });
  }

  return matches;
}
