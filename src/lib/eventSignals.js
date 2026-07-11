/**
 * Standalone analytics boundary. Events intentionally stay local unless a future deployment
 * explicitly configures an anonymous analytics client.
 * @param {string} eventName
 * @param {Record<string, unknown>} [properties]
 */
export function trackAnalyticsEvent(eventName, properties = {}) {
  void eventName;
  void properties;
}
