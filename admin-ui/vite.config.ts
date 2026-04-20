import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Vite only treats URLs under `base` (`/admin/`) as the app; `/admin` does not start with that prefix. */
function adminCanonicalBaseRedirect(): Plugin {
  const adminIndexPath = path.resolve(__dirname, "index.html");

  return {
    name: "admin-canonical-base-redirect",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const raw = req.url ?? "";
        const pathname = raw.split("?")[0] ?? "";

        if (pathname === "/login" || pathname === "/login/" || pathname === "/register" || pathname === "/register/") {
          res.writeHead(302, { Location: "/admin/" });
          res.end();
          return;
        }

        if (pathname === "/" || pathname === "/index.html") {
          if (!fs.existsSync(adminIndexPath)) {
            res.writeHead(302, { Location: "/admin/" });
            res.end();
            return;
          }

          try {
            const html = fs.readFileSync(adminIndexPath, "utf8");
            const transformed = await server.transformIndexHtml(raw, html, req.originalUrl);
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(transformed);
          } catch (error) {
            next(error as Error);
          }
          return;
        }

        if (pathname !== "/admin") {
          next();
          return;
        }
        const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
        res.writeHead(308, { Location: `/admin/${query}` });
        res.end();
      });
    }
  };
}

export default defineConfig({
  root: path.resolve(__dirname),
  base: "/admin/",
  plugins: [adminCanonicalBaseRedirect(), tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  server: {
    port: 5173,
    // Fail fast if 5173 is taken — otherwise Vite picks 5174 while the tunnel still targets 5173 and you
    // hit another process that rejects the tunnel Host header.
    strictPort: true,
    allowedHosts: [".blueprintdata.xyz"],
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true
  }
});
