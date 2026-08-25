import jenkins.model.*
import hudson.security.*

def jenkins = Jenkins.get()
def realm = jenkins.getSecurityRealm()
if (realm instanceof HudsonPrivateSecurityRealm) {
  def u = hudson.model.User.getById("admin", true)
  u.addProperty(HudsonPrivateSecurityRealm.Details.fromPlainPassword("__CHESSALIVE_ADMIN_PASSWORD__"))
  u.save()
  println("chessalive-ci: admin password reset")
}
