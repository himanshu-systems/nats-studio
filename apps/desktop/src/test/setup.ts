import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// vitest.config.ts keeps globals off, so @testing-library/react's automatic
// afterEach(cleanup) never registers itself — do it explicitly instead.
afterEach(cleanup);
