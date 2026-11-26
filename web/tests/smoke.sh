#!/usr/bin/env bash
# End-to-end smoke test of the PHP site.
# Needs: a freshly seeded database (schema.sql + seed.sql), the site running at $BASE
# (default http://127.0.0.1:8000/index.php), curl, and the mysql client logged in as root.
# It changes data (creates, edits and deletes users), so re-seed afterwards.
B=${BASE:-http://127.0.0.1:8000/index.php}
T=$(mktemp -d)
pass=0; fail=0
ok()   { echo "PASS $1"; pass=$((pass+1)); }
bad()  { echo "FAIL $1"; fail=$((fail+1)); }
chk()  { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# jar-specific helpers
get()  { curl -s -b $T/$1 -c $T/$1 "$B?url=$2"; }
hdr()  { curl -s -o /dev/null -D - -b $T/$1 -c $T/$1 "$B?url=$2"; }
tok()  { get $1 "$2" | grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//'; }
post() { local j=$1 r=$2; shift 2; curl -s -o /dev/null -D - -b $T/$j -c $T/$j -X POST "$B?url=$r" "$@"; }
loc()  { grep -i '^location:' | tr -d '\r' | sed 's/^[Ll]ocation: //'; }
login(){ local t; t=$(tok $1 login); post $1 login --data-urlencode "_csrf=$t" --data-urlencode "login=$2" --data-urlencode "password=$3" | loc; }

# --- search ---
P=$(get g games)
chk "games lists lobby game" "grep -q 'Paradox Pit' <<<\"\$P\""
chk "games hides finished game" "! grep -q 'Old Finished Match' <<<\"\$P\""
P=$(get g 'games&q=100%25')
chk "literal % search matches only Anchor Wars" "grep -q 'Anchor Wars' <<<\"\$P\" && grep -q '1 active game ' <<<\"\$P\""
P=$(get g "games&q=%27%20OR%201%3D1%20--")
chk "injection string finds nothing, no error" "grep -q '0 active games' <<<\"\$P\""
P=$(get g 'games&status=running&sort=bogus')
chk "status filter running" "grep -q 'Timeline Brawl' <<<\"\$P\" && ! grep -q 'Paradox Pit' <<<\"\$P\""
P=$(get g 'games&open=1')
chk "open-slots filter hides full game" "! grep -q 'Timeline Brawl' <<<\"\$P\""
J=$(curl -s "$B?url=api/games&q=guest")
chk "json api" "grep -q '\"name\":\"Guest Skirmish\"' <<<\"\$J\""

# --- cookie flags ---
H=$(hdr c login)
chk "session cookie HttpOnly+SameSite" "grep -i 'set-cookie: dominion_sid' <<<\"\$H\" | grep -qi 'httponly' && grep -i 'set-cookie: dominion_sid' <<<\"\$H\" | grep -qi 'samesite=lax'"

# --- register ---
t=$(tok n register)
L=$(post n register --data-urlencode "_csrf=$t" -d username=newbie --data-urlencode "email=new@example.com" \
    --data-urlencode "display_name=<script>alert(1)</script>" -d password=Secret123 -d password_confirm=Secret123 | loc)
chk "register redirects to dashboard" "[[ \"\$L\" == *dashboard ]]"
P=$(get n dashboard)
chk "dashboard escapes display name" "grep -q '&lt;script&gt;' <<<\"\$P\" && ! grep -q '<script>alert' <<<\"\$P\""
chk "new user is member" "grep -q 'badge\">member' <<<\"\$P\""
H=$(hdr n admin/members)
chk "member gets 403 on members list" "grep -q ' 403' <<<\"\$H\""
mysql -uroot dominion -N -e "select password_hash from users where username='newbie'" | grep -q '^\$2y\$' && ok "password stored as bcrypt hash" || bad "password stored as bcrypt hash"

t=$(tok x register)
post x register --data-urlencode "_csrf=$t" -d username=newbie -d email=other@example.com -d password=Secret123 -d password_confirm=Secret123 >/dev/null
chk "duplicate username rejected" "get x register | grep -q 'That username is taken'"
post x register --data-urlencode "_csrf=$t" -d username=ab -d email=bad -d password=short -d password_confirm=nope >/dev/null
P=$(get x register)
chk "validation errors shown" "grep -q 'Username must be' <<<\"\$P\" && grep -q 'valid email' <<<\"\$P\" && grep -q 'at least 8' <<<\"\$P\""

# --- CSRF ---
L=$(post n account/edit -d username=hacked -d email=h@example.com | loc)
P=$(get n account)
chk "POST without CSRF token rejected" "grep -q 'form expired' <<<\"\$P\" && grep -q 'newbie' <<<\"\$P\""

# --- account CRUD ---
t=$(tok n account/edit)
post n account/edit --data-urlencode "_csrf=$t" -d username=newbie2 -d email=new2@example.com -d display_name=Newbie >/dev/null
chk "profile update" "get n account | grep -q 'new2@example.com'"
t=$(tok n account/password)
post n account/password --data-urlencode "_csrf=$t" -d current_password=wrong -d password=Another123 -d password_confirm=Another123 >/dev/null
chk "password change needs current password" "get n account/password | grep -q 'Current password is incorrect'"
post n account/password --data-urlencode "_csrf=$t" -d current_password=Secret123 -d password=Another123 -d password_confirm=Another123 >/dev/null
chk "password changed" "get n account | grep -q 'Password changed'"

# --- logout / login ---
t=$(tok n dashboard)
L=$(post n logout --data-urlencode "_csrf=$t" | loc)
H=$(hdr n dashboard)
chk "logout ends session" "grep -qi 'location: index.php?url=login' <<<\"\$H\""
L=$(login n newbie2 Secret123)
chk "old password fails" "[[ \"\$L\" == *login ]]"
L=$(login n new2@example.com Another123)
chk "login by email with new password" "[[ \"\$L\" == *dashboard ]]"

# --- game handoff ---
t=$(tok n games)
L=$(post n games/play --data-urlencode "_csrf=$t" -d game_id=1 | loc)
chk "member gets ticket on join" "[[ \"\$L\" =~ ^http://localhost:3000/\?game=1\&ticket=[0-9a-f]{64}$ ]]"
TK=${L##*ticket=}
chk "ticket stored in DB" "mysql -uroot dominion -N -e \"select count(*) from game_tickets where token='$TK' and expires_at > now()\" | grep -qx 1"
t=$(tok g games)
L=$(post g games/play --data-urlencode "_csrf=$t" -d game_id=3 | loc)
chk "guest joins without ticket" "[[ \"\$L\" == 'http://localhost:3000/?game=3' ]]"

# --- delete own account ---
t=$(tok n account/delete)
post n account/delete --data-urlencode "_csrf=$t" -d password=Another123 >/dev/null
chk "account deleted" "! mysql -uroot dominion -N -e \"select 1 from users where username='newbie2'\" | grep -q 1"

# --- staff ---
L=$(login m moderator 'Password123!')
chk "moderator login" "[[ \"\$L\" == *dashboard ]]"
chk "moderator can list members" "get m admin/members | grep -q 'player1'"
chk "moderator can search members" "get m 'admin/members&q=mod' | grep -q '1 member found'"
H=$(hdr m 'admin/members/edit&id=3')
chk "moderator cannot edit (403)" "grep -q ' 403' <<<\"\$H\""

L=$(login a admin 'Password123!')
chk "admin login" "[[ \"\$L\" == *dashboard ]]"
P=$(get a 'admin/members&sort=email&dir=desc')
chk "admin sorted member list" "grep -q 'player1@example.com' <<<\"\$P\""
P=$(get a 'admin/members&sort=email);DROP%20TABLE%20users;--')
chk "bad sort column ignored" "grep -q 'player1@example.com' <<<\"\$P\""
PID=$(mysql -uroot dominion -N -e "select user_id from users where username='player1'")
t=$(tok a "admin/members/edit&id=$PID")
post a "admin/members/edit&id=$PID" --data-urlencode "_csrf=$t" -d id=$PID -d username=player1 -d email=player1@example.com -d display_name=P1 -d role_id=2 -d status=disabled >/dev/null
chk "admin changes role and disables" "mysql -uroot dominion -N -e 'select role_id,status from users where user_id=$PID' | grep -q '2.disabled'"
L=$(login p player1 'Password123!')
chk "disabled user cannot log in" "[[ \"\$L\" == *login ]]"
AID=$(mysql -uroot dominion -N -e "select user_id from users where username='admin'")
t=$(tok a account/delete)
post a account/delete --data-urlencode "_csrf=$t" -d 'password=Password123!' >/dev/null
chk "last admin cannot delete self" "mysql -uroot dominion -N -e 'select 1 from users where user_id=$AID' | grep -q 1"
t=$(tok a "admin/members/show&id=$PID")
post a admin/members/delete --data-urlencode "_csrf=$t" -d id=$PID >/dev/null
chk "admin deletes member" "! mysql -uroot dominion -N -e 'select 1 from users where user_id=$PID' | grep -q 1"
chk "404 page" "hdr a nope | grep -q ' 404'"

# --- throttling ---
for i in 1 2 3 4 5; do login z moderator wrongpass >/dev/null; done
login z moderator 'Password123!' >/dev/null
chk "throttle after 5 failures" "get z login | grep -q 'Too many failed attempts'"

echo; echo "$pass passed, $fail failed"
