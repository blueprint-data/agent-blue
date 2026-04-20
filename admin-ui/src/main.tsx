import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import LandingPage from "./landing/LandingPage";
import "./styles.css";

const baseName = import.meta.env.BASE_URL.replace(/\/$/, "") || undefined;
const pathname = window.location.pathname;
const isAdminSurface = pathname === "/admin" || pathname.startsWith("/admin/");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isAdminSurface ? (
      <BrowserRouter basename={baseName}>
        <App />
      </BrowserRouter>
    ) : (
      <LandingPage />
    )}
  </React.StrictMode>
);
