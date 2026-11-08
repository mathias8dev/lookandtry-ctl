import { fileURLToPath } from "node:url";
export const cliCommand = process.env.LOOKCTL_TEST_EXECUTABLE ?? process.execPath;
export const cliPrefix = process.env.LOOKCTL_TEST_EXECUTABLE ? [] : [fileURLToPath(new URL("../dist/cli.js", import.meta.url))];
