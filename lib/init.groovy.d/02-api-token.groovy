import jenkins.model.*
import hudson.model.*
import jenkins.security.ApiTokenProperty

def home = Jenkins.get().getRootDir()
new File(home, "chessalive-ci-marker.txt").text = "init.groovy.d ran at ${new Date()}\n"

def u = User.getById("admin", true)
def prop = u.getProperty(ApiTokenProperty.class)
if (prop == null) { prop = new ApiTokenProperty(); u.addProperty(prop) }
// Revoke any prior token of this name so re-running is idempotent.
prop.tokenStore.getTokenListSortedByName().findAll { it.name == "chessalive-ci" }.each {
  prop.tokenStore.revokeToken(it.getUuid())
}
def res = prop.tokenStore.generateNewToken("chessalive-ci")
u.save()
def f = new File(home, "chessalive-ci-api-token.txt")
f.text = res.plainValue
f.setReadable(false, false); f.setReadable(true, true)
f.setWritable(false, false); f.setWritable(true, true)
println("chessalive-ci: api token generated")
