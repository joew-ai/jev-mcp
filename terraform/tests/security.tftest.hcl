mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111122223333" }
  }
}
variables {
  workload_account_id = "111122223333"
  oauth_issuer        = "https://issuer.example/"
  oauth_jwks_url      = "https://issuer.example/keys"
  allowed_subjects    = ["member"]
  jev_secret_arn      = "arn:aws:secretsmanager:us-east-1:111122223333:secret:jev-ABCDEF"
}
run "security_configuration" {
  command = plan
  assert {
    condition     = jsondecode(aws_iam_role_policy.runtime.policy).Statement[0].Resource == var.jev_secret_arn
    error_message = "Secret permission must be restricted to the exact ARN."
  }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.runtime.policy).Statement) == 2
    error_message = "Default role must only read its secret and write its own logs."
  }
}
run "reject_cross_account_secret" {
  command = plan
  variables {
    jev_secret_arn = "arn:aws:secretsmanager:us-east-1:999988887777:secret:jev-ABCDEF"
  }
  expect_failures = [aws_iam_role_policy.runtime]
}
run "reject_empty_membership" {
  command = plan
  variables {
    allowed_subjects = []
  }
  expect_failures = [var.allowed_subjects]
}
