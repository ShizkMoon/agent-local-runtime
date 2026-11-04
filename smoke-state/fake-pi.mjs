process.stdout.write(JSON.stringify({ type: "fake_pi_args", argv: process.argv.slice(2) }) + "\n");
process.exit(Number(process.env.FAKE_PI_EXIT ?? 0));
