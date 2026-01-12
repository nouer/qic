import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/**/*.test.js"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "lcov"],
            reportsDirectory: "./out/coverage",
            include: ["src/{text,diffCheck,qiitaUrl,logger,images}.js"],
            exclude: [
                "src/cli.js",
                "src/qic.js",
                "src/qiitaUi.js",
                "src/qiitaUploadedFilesUi.js"
            ],
            thresholds: {
                lines: 100,
                functions: 100,
                statements: 100,
                branches: 100
            }
        }
    }
});

