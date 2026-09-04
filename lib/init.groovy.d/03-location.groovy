import jenkins.model.JenkinsLocationConfiguration
// The CLI refuses to handshake until the root URL is set ("Jenkins URL is not configured").
// On a box that is fronted by Caddy (chessalive-ci install-linux.sh + lib/expose-jenkins.sh) the
// public name lives in JENKINS_HOME/chessalive-ci-public-url.txt; without that file the controller
// is loopback-only and the root URL is the tunnel address.
def home = jenkins.model.Jenkins.get().getRootDir()
def urlFile = new File(home, "chessalive-ci-public-url.txt")
def url = urlFile.exists() ? urlFile.text.trim() : "http://127.0.0.1:8080/"
if (!url.endsWith("/")) url += "/"
def loc = JenkinsLocationConfiguration.get()
loc.setUrl(url)
if (!loc.getAdminAddress() || loc.getAdminAddress().startsWith("address not configured")) {
  loc.setAdminAddress("ChessAlive CI <contact@chessalive.com>")
}
loc.save()
println("chessalive-ci: jenkins url set to " + url)
