import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tempDir } from "./helpers.ts";

export function findTestExecutable(name: string): string {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  return execFileSync(locator, [name], { encoding: "utf8" }).trim().split(/\r?\n/, 1)[0]!;
}

export function testPath(directory: string, previous = process.env.PATH): string {
  return [directory, previous].filter(Boolean).join(delimiter);
}

let windowsShim: Buffer | undefined;

// Node's process APIs on Windows can't execute a POSIX shebang or a batch file directly.
// Compile one small host launcher, then reuse its bytes for each test CLI name.
function nativeNodeShim(): Buffer {
  if (windowsShim) return windowsShim;
  const framework = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET");
  const compiler = ["Framework64", "Framework"].map((dir) => join(framework, dir, "v4.0.30319", "csc.exe")).find(existsSync);
  if (!compiler) throw new Error("Windows CLI fixture tests require the installed .NET Framework C# compiler.");
  const directory = tempDir("shipyard-cli-shim-");
  const source = join(directory, "launcher.cs");
  const executable = join(directory, "launcher.exe");
  try {
    writeFileSync(source, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

public static class NodeLauncher {
    private static string Quote(string value) {
        return "\"" + Regex.Replace(value, @"(\\*)(""|$)", match => {
            var slashes = match.Groups[1].Value;
            return slashes + slashes + (match.Groups[2].Length != 0 ? "\\\"" : "");
        }) + "\"";
    }

    public static int Main(string[] args) {
        string script = Path.ChangeExtension(Assembly.GetExecutingAssembly().Location, ".cjs");
        var info = new ProcessStartInfo(${JSON.stringify(process.execPath)}) {
            Arguments = Quote(script) + " " + String.Join(" ", Array.ConvertAll(args, Quote)),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var child = Process.Start(info)) {
            var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            ThreadPool.QueueUserWorkItem(_ => {
                try {
                    var input = Console.OpenStandardInput();
                    var writer = child.StandardInput.BaseStream;
                    var buffer = new byte[8192];
                    int count;
                    while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                        writer.Write(buffer, 0, count);
                        writer.Flush();
                    }
                }
                catch (IOException) { }
                catch (InvalidOperationException) { }
                finally { try { child.StandardInput.Close(); } catch (IOException) { } }
            });
            child.WaitForExit();
            Task.WaitAll(output, error);
            return child.ExitCode;
        }
    }
}
`);
    execFileSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], { stdio: "pipe", windowsHide: true });
    windowsShim = readFileSync(executable);
    return windowsShim;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function writeTestExecutable(directory: string, name: string, source: string): string {
  const script = source.replace(/^#![^\r\n]*\r?\n/, "");
  const file = join(directory, name);
  if (process.platform === "win32") {
    writeFileSync(`${file}.cjs`, script);
    writeFileSync(`${file}.exe`, nativeNodeShim());
    return `${file}.exe`;
  }
  writeFileSync(file, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  return file;
}
