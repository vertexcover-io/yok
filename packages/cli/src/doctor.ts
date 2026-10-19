import { Command } from "@commander-js/extra-typings";
import {
  builtInChecks,
  type DoctorJson,
  type DoctorReport,
  findWorkflowPath,
  loadStartEnv,
  runDoctor,
  verdict,
  workflowChecks,
} from "@yok/core";
import { stopRunningOnSignal } from "@yok/sdk";
import { exitCodeFor, renderText, runtimeChecks } from "@yok/server";
import { cliLog, commandLog, compileOrFail } from "./client.ts";

export const renderJson = (report: DoctorReport): string => {
  const json: DoctorJson = { ...report, verdict: verdict(report) };
  return JSON.stringify(json, null, 2);
};

// Without a workflow, the env a run would get from the .env and the config alone.
const declaredChecks = async (workflow: string | undefined) => {
  const cwd = process.cwd();
  if (workflow === undefined) {
    const env = await loadStartEnv(null, cwd, { env: {}, agent: "claude" });
    return builtInChecks(undefined, env);
  }
  const plan = await compileOrFail(findWorkflowPath(workflow, cwd), cwd);
  if (plan === null) return null;
  const env = await loadStartEnv(null, cwd, plan);
  return [...workflowChecks(plan.doctor, env), ...builtInChecks(plan, env)];
};

export const doctorCommand = () =>
  new Command("doctor")
    .description("Check the tools, repository and config a yok run needs")
    .option("--json", "print the report as JSON")
    .option("--workflow <name|path>", "also run the checks this workflow declares")
    .action(async ({ json, workflow }) => {
      stopRunningOnSignal();
      const declared = await declaredChecks(workflow);
      if (declared === null) return;
      const report = await runDoctor({
        cwd: process.cwd(),
        extraChecks: [...runtimeChecks("claude"), ...declared],
        log: cliLog(),
      });
      commandLog("doctor").debug(
        { verdict: verdict(report), failed: report.failed.length, warned: report.warned.length },
        "doctor finished",
      );
      console.log(json === true ? renderJson(report) : renderText(report));
      process.exitCode = exitCodeFor(report);
    });
