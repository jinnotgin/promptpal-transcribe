import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createAppRouter } from "./app/router.js";
import "./assets/index.css";

createApp(App).use(createPinia()).use(createAppRouter()).mount("#app");
