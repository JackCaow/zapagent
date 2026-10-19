import { z } from "zod";
import type { Tool } from "../tools/types.js";

export function currentTimeTool(): Tool {
  return {
    definition: {
      name: "current_time",
      description: "Get the current date and time, with optional timezone and format.",
      parameters: z.object({
        timezone: z.string().optional().describe("IANA timezone (e.g. 'Asia/Shanghai', 'America/New_York'). Default: system local"),
        format: z.string().optional().describe("'iso' for ISO 8601, 'date' for date only, 'time' for time only, 'full' for human-readable (default: 'full')"),
      }),
      permission: "auto",
      readOnly: true,
    },
    handler: async (args) => {
      const format = (args.format as string | undefined) ?? "full";
      const timezone = args.timezone as string | undefined;

      const now = new Date();

      try {
        let output: string;

        switch (format) {
          case "iso":
            output = timezone
              ? now.toLocaleString("sv", { timeZone: timezone }).replace(" ", "T")
              : now.toISOString();
            break;
          case "date":
            output = timezone
              ? now.toLocaleDateString("en-CA", { timeZone: timezone })
              : now.toISOString().split("T")[0];
            break;
          case "time":
            output = timezone
              ? now.toLocaleTimeString("en-GB", { timeZone: timezone })
              : now.toLocaleTimeString("en-GB");
            break;
          default: {
            const options: Intl.DateTimeFormatOptions = {
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
              ...(timezone ? { timeZone: timezone } : {}),
            };
            output = now.toLocaleString("en-US", options);
            if (timezone) output += ` (${timezone})`;
            break;
          }
        }

        return { success: true, output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: "", error: message };
      }
    },
  };
}
