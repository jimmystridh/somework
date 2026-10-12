import { describe, it } from "node:test";
import { expectAllowed, expectDestructive, LOCAL, REMOTE } from "./classifier-support.ts";

describe("finding what is hidden behind an allowed command", () => {
	it("refuses variables that change how programs are found, loaded or where they connect", () => {
		expectDestructive(
			[
				["LD_PRELOAD=/tmp/x.so ls", "system"],
				["export LD_PRELOAD=/tmp/x.so", "system"],
				["LD_LIBRARY_PATH=/tmp ls", "system"],
				["BASH_ENV=/tmp/x.sh bash -c true", "system"],
				["GIT_SSH_COMMAND='ssh -i /x' git fetch", "system"],
				["GIT_ASKPASS=/tmp/x git fetch", "system"],
				["HTTPS_PROXY=http://evil:3128 npm test", "system"],
				["DOCKER_HOST=ssh://pve-host docker ps", "system"],
				["env LD_PRELOAD=/tmp/x.so ls", "system"],
				["IFS=/ ls", "system"],
				["x=1; PROMPT_COMMAND='rm -rf /' ls", "system"],
				["export SSH_AUTH_SOCK=/tmp/agent", "system"],
			],
			LOCAL,
		);
		expectDestructive([["PATH=/tmp:$PATH ls", "system"], ["export PATH=/tmp:$PATH", "system"], ["env PATH=/tmp ls", "system"]], REMOTE);
		expectAllowed(["PATH=$PATH:/usr/local/go/bin go version", "export PATH=$PATH:/x", "FOO=bar npm test", "NODE_ENV=test npm test", "X=1 Y=2 ls"], LOCAL);
	});

	it("refuses reading what a search by a secret's name found, however the two are joined", () => {
		expectDestructive(
			[
				["find / -name id_rsa | xargs cat", "secrets"],
				["find / -name '*.pem' -exec cat {} \\;", "secrets"],
				["find ~ -name id_ed25519 -exec cp {} /workspace/ \\;", "secrets"],
				["cat $(find / -name '*.pem')", "secrets"],
				['cat "$(find /srv -name .env)"', "secrets"],
				["ls ~/.ssh/id_* | xargs cat", "secrets"],
				["find / -name '*.key' | head -1 | xargs -I{} base64 {}", "secrets"],
				["for f in $(find / -name 'id_rsa'); do cat $f; done", "secrets"],
			],
			LOCAL,
		);
		expectAllowed(["find / -name '*.pem'", "find . -name '*.key' | wc -l", "ls ~/.ssh", "find / -name id_rsa 2>/dev/null | head", "find . -name '*.ts' | xargs wc -l"], LOCAL);
	});

	it("sees the environment through every language that can print it", () => {
		expectDestructive(
			[
				["perl -e 'print join(\"\\n\", %ENV)'", "secrets"],
				["perl -e 'print $ENV{GIT_TOKEN}'", "secrets"],
				["ruby -e 'puts ENV.to_h'", "secrets"],
				["php -r 'print_r(getenv());'", "secrets"],
				["php -r 'var_dump($_ENV);'", "secrets"],
				["python3 -c 'import os; print(dict(os.environ))'", "secrets"],
				["python3 -c 'import os; print(os.getenv(\"GIT_TOKEN\"))'", "secrets"],
				["node -p 'process.env'", "secrets"],
				["awk 'BEGIN { for (k in ENVIRON) print k, ENVIRON[k] }'", "data"],
				["jq -n '$ENV'", "secrets"],
			],
			LOCAL,
		);
	});

	it("knows more places where secrets are written down", () => {
		expectDestructive(
			[
				["cat ~/.bash_history", "secrets"],
				["tail /home/js/.zsh_history", "secrets"],
				["cat ~/.psql_history", "secrets"],
				["cat /var/lib/docker/containers/abc123/config.v2.json", "secrets"],
				["cat /etc/ssh/ssh_host_ed25519_key", "secrets"],
				["cat ~/.npmrc", "secrets"],
				["cat /home/js/.npmrc", "secrets"],
				["systemctl show docker", "secrets"],
				["systemctl show -p Environment somework-reviewer", "secrets"],
			],
			REMOTE,
		);
		expectAllowed(["cat .npmrc", "systemctl show -p ActiveState docker", "systemctl show -p MainPID docker"], REMOTE);
	});

	it("reads a script given on standard input to ssh, docker exec or a shell, and judges what it says", () => {
		expectDestructive(
			[
				["ssh agents 'bash -s' <<'EOF'\nrm -rf /srv/app\nEOF", "data"],
				["ssh agents bash <<EOF\nprintenv\nEOF", "secrets"],
				["ssh agents sh <<< 'docker volume prune -f'", "data"],
				["echo 'rm -rf /srv' | ssh agents sh", "data"],
				["ssh agents bash", "unknown"],
				["cat fix.sh | ssh agents bash", "unknown"],
			],
			LOCAL,
		);
		expectAllowed(["ssh agents bash <<EOF\ndocker ps\nuptime\nEOF", "echo 'docker ps' | ssh agents sh", "ssh agents 'bash -s' <<'EOF'\ndf -h\nEOF"], LOCAL);
	});

	it("refuses searching, archiving and copying whole trees on a machine, where secrets sit in files nobody names", () => {
		expectDestructive(
			[
				["scp -r agents:/home/js/somework-pilot ./", "secrets"],
				["rsync -a agents:/home/js/somework-pilot/ ./pilot/", "secrets"],
			],
			LOCAL,
		);
		expectDestructive(
			[
				["grep -r token ~/somework-pilot", "secrets"],
				["grep -rn password /home/js", "secrets"],
				["grep -r error .", "secrets"],
				["rg token ~/somework-pilot", "secrets"],
				["ag password /srv", "secrets"],
				["tar czf - ~/somework-pilot | base64", "secrets"],
				["tar -cf - /srv | wc -c", "secrets"],
			],
			REMOTE,
		);
		expectAllowed(["grep -r error /var/log/", "grep -rn timeout /var/log/syslog", "tar -tzf x.tgz", "grep error /var/log/syslog", "docker logs agent 2>&1 | grep -i error"], REMOTE);
		expectAllowed(["grep -rn requestApproval packages", "rg token docs", "tar -czf x.tgz src", "scp agents:/home/js/somework-pilot/reviewer/compose.yaml ./compose.yaml"], LOCAL);
	});
});

describe("one-liners with bundled flags", () => {
	it("reads the code after -pe, -ne, -lane and -Bc like the code after -e and -c", () => {
		expectDestructive(
			[
				["perl -pe 'system(\"rm -rf /\")'", "data"],
				["perl -ne 'unlink $_' list", "data"],
				["perl -lane 'print $ENV{HOME}' x", "secrets"],
				["ruby -ne 'File.delete($_.chomp)' list", "data"],
				["python3 -Bc 'import shutil; shutil.rmtree(\"/srv\")'", "data"],
				["perl -pi -e 's/a/b/' /etc/x", "data"],
			],
			LOCAL,
		);
		expectAllowed(["perl -ne 'print if /error/' app.log", "perl -lane 'print $F[0]' access.log", "ruby -ne 'puts $_' file.txt", "perl -pe 's/a/b/' in.txt", "python3 -Bc 'print(1)'"], LOCAL);
	});
});

describe("working in a directory that holds secrets", () => {
	it("refuses reading by relative name after a cd into one", () => {
		expectDestructive([["cd ~/.ssh; cat *", "secrets"], ["cd ~/.ssh && cat known_hosts", "secrets"], ["cd /run/secrets && cat git-token", "secrets"], ["cd secrets/ && cat sandbox-token", "secrets"], ["cd ./secrets && base64 token", "secrets"], ["pushd ~/.aws && cat credentials", "secrets"]], REMOTE);
		expectAllowed(["cd src && cat main.ts", "cd ~/somework-pilot && ls", "cd /var/log && tail -n 20 syslog", "cd ~/.ssh && ls"], REMOTE);
	});
});

describe("read-only programs that write or run something after all", () => {
	it("refuses the second file of uniq and xxd, and programs that write with an option or run what they inspect", () => {
		expectDestructive(
			[
				["uniq in.txt /etc/out", "data"],
				["xxd -r dump.hex /etc/blob", "data"],
				["getent shadow root", "secrets"],
				["ldd ./downloaded-binary", "unknown"],
				["iconv -f latin1 -t utf8 -o /etc/x in.txt", "unknown"],
				["shuf -o /etc/x in.txt", "unknown"],
				["sdiff -o /etc/merged a b", "unknown"],
				["tree -o /etc/listing.txt", "unknown"],
			],
			LOCAL,
		);
		expectAllowed(["uniq in.txt out.txt", "uniq -c in.txt", "xxd file.bin", "xxd -r dump.hex blob.bin", "getent passwd root", "getent hosts example.com"], LOCAL);
	});

	it("allows a harmless pager or editor to be named and refuses one that runs something", () => {
		expectAllowed(["GIT_PAGER=cat git log -3", "PAGER=cat git diff", "GIT_EDITOR=true git commit"], LOCAL);
		expectDestructive([["GIT_PAGER='sh -c id' git log", "system"], ["EDITOR=/tmp/evil git commit", "system"], ["LESSOPEN='|/tmp/x %s' less file", "system"], ["export VISUAL=/tmp/x", "system"]], LOCAL);
	});
});
