use crate::{CacheName, Error, Role, TokenGrant};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenClaims {
    pub sub: String,
    pub iat: usize,
    pub exp: usize,
    pub iss: String,
    pub aud: String,
    pub jti: String,
    pub grants: Vec<TokenGrant>,
}

impl TokenClaims {
    pub fn allows(&self, cache: &str, role: Role) -> bool {
        self.grants
            .iter()
            .any(|grant| (grant.cache == cache || grant.cache == "*") && grant.role.permits(&role))
    }

    pub fn can_delegate(&self, caches: &[TokenGrant]) -> bool {
        !caches.is_empty()
            && caches.iter().all(|grant| {
                self.grants.iter().any(|parent| {
                    parent.role == Role::Admin
                        && (parent.cache == "*" || parent.cache == grant.cache)
                })
            })
    }

    pub fn can_delegate_until(
        &self,
        caches: &[TokenGrant],
        requested_exp: usize,
        now: usize,
    ) -> bool {
        requested_exp > now && requested_exp <= self.exp && self.can_delegate(caches)
    }

    pub fn validate_policy(&self) -> Result<(), Error> {
        if self.sub.is_empty() || self.sub.len() > 256 || !self.sub.is_ascii() {
            return Err(Error::InvalidTokenSubject);
        }
        if self.jti.is_empty()
            || self.jti.len() > 128
            || !self.jti.is_ascii()
            || self.iss.is_empty()
            || self.aud.is_empty()
            || self.iss.len() > 256
            || self.aud.len() > 256
        {
            return Err(Error::InvalidTokenClaims);
        }
        if self.exp <= self.iat {
            return Err(Error::InvalidTokenClaims);
        }
        if self.grants.is_empty() || self.grants.len() > 256 {
            return Err(Error::InvalidTokenGrant);
        }
        for grant in &self.grants {
            if grant.cache != "*" {
                grant
                    .cache
                    .parse::<CacheName>()
                    .map_err(|_| Error::InvalidTokenGrant)?;
            }
        }
        Ok(())
    }
}
