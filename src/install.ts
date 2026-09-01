import { spawn } from "node:child_process";

export class InstallError extends Error {
  override name = "InstallError";
  constructor(readonly wrapper: string, message: string) {
    super(message);
  }
}

export async function installWithBun(wrapper: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", ["install"], {
      cwd: wrapper,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.once("error", (error) => reject(new InstallError(
      wrapper,
      `could not start bun install: ${error.message}`,
    )));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new InstallError(
        wrapper,
        signal ? `bun install ended from ${signal}` : `bun install exited with code ${code ?? "unknown"}`,
      ));
    });
  });
}
