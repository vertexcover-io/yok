import { Command } from "@commander-js/extra-typings";
import {
  builtInChecks,
  type DoctorJson,
  type DoctorReport,
  DoctorReportSchema,
  loadStartEnv,
  locateWorkflow,
  runDoctor,
  verdict,
  workflowChecks,
} from "@yok/core";
import { stopRunningOnSignal, yokHome } from "@yok/sdk";
import { renderDoctorReport, runtimeChecks } from "@yok/server";
import {
  apiErrorText,
  cliLog,
  commandLog,
  compileOrFail,
  connect,
  fail,
  isRemote,
} from "./client.ts";
import { PROJECT_REQUIRED } from "./project.ts";

export const renderJson = (report: DoctorReport): string => {
  const json: DoctorJson = { ...report, verdict: verdict(report) };
  return JSON.stringify(json, null, 2);
};

export const exitCodeFor = (report: DoctorReport): number => (report.failed.length > 0 ? 1 : 0);

// Without a workflow, the env a run would get from the .env and the config alone.
const declaredChecks = async (workflow: string | undefined) => {
  const cwd = process.cwd();
  if (workflow === undefined) {
    const env = await loadStartEnv(null, cwd, { env: {}, agent: "claude" });
    return builtInChecks(undefined, env);
  }
  const located = await locateWorkflow(workflow, cwd);
  if (!located.ok) {
    fail(located.error);
    return null;
  }
  const plan = await compileOrFail(located.value, cwd);
  if (plan === null) return null;
  const env = await loadStartEnv(null, cwd, plan);
  return [...workflowChecks(plan.doctor, env), ...builtInChecks(plan, env)];
};

export const doctorCommand = () =>
  new Command("doctor")
    .description("Check the tools, repository and config a yok run needs")
    .option("--json", "print the report as JSON")
    .option("--workflow <name|path>", "also run the checks this workflow declares")
    .option("--project <name>", "with --remote: the server's project to check")
    .action(async ({ json, workflow, project }, command) => {
      if (isRemote(command)) {
        if (project === undefined) return fail(PROJECT_REQUIRED);
        const { client } = await connect(process.env, yokHome());
        const checked = await client.doctor({
          project,
          ...(workflow === undefined ? {} : { workflow }),
        });
        if (!checked.ok) return fail(apiErrorText(checked.error));
        const report = DoctorReportSchema.parse(checked.value.report);
        console.log(json === true ? renderJson(report) : renderDoctorReport(report));
        process.exitCode = exitCodeFor(report);
        return;
      }
      if (project !== undefined) {
        return fail("--project needs --remote: yok doctor checks this checkout");
      }
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
      console.log(json === true ? renderJson(report) : renderDoctorReport(report));
      process.exitCode = exitCodeFor(report);
    });
