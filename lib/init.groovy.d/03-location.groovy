import jenkins.model.JenkinsLocationConfiguration
// The CLI refuses to handshake until the root URL is set ("Jenkins URL is not configured").
def loc = JenkinsLocationConfiguration.get()
loc.setUrl("http://127.0.0.1:8080/")
if (!loc.getAdminAddress() || loc.getAdminAddress().startsWith("address not configured")) {
  loc.setAdminAddress("ChessAlive CI <contact@chessalive.com>")
}
loc.save()
println("chessalive-ci: jenkins url set")
