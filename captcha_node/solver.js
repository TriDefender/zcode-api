process.env.FONTCONFIG_PATH = "/dev/null";
const backend = process.env.ZCODE_CAPTCHA_BACKEND || "jsdom";
const solve =
	backend === "jsdom"
		? require("./solve-core").solveTraceless
		: backend === "happy"
			? require("./solve-happy-lib").solveTraceless
			: require("./solve-playwright").solveTraceless;

const SCENE = process.argv[2] || "11xygtvd";
const REGION = process.argv[3] || "sgp";
const PREFIX = process.argv[4] || "no8xfe";

solve({ scene: SCENE, region: REGION, prefix: PREFIX })
	.then((param) => {
		console.log("VERIFY_PARAM=" + param);
		process.exit(0);
	})
	.catch((err) => {
		process.stderr.write(String(err?.message || err) + "\n");
		process.exit(1);
	});
