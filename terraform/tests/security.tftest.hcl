mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111122223333" }
  }
}
variables {
  workload_account_id = "111122223333"
  allowed_subjects    = ["member"]
  oauth_password_hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  jev_secret_arn      = "arn:aws:secretsmanager:us-east-1:111122223333:secret:jev-ABCDEF"
}
run "security_configuration" {
  command = plan
  assert {
    condition     = aws_kms_key.oauth.key_usage == "SIGN_VERIFY"
    error_message = "OAuth key must be a signing key."
  }
  assert {
    condition     = aws_kms_key.oauth.customer_master_key_spec == "RSA_2048"
    error_message = "OAuth key must be RSA 2048."
  }
  assert {
    condition     = aws_dynamodb_table.oauth_codes.hash_key == "pk"
    error_message = "Authorization codes use a single partition key."
  }
  assert {
    condition     = aws_dynamodb_table.oauth_codes.ttl[0].enabled
    error_message = "Authorization codes must expire via TTL."
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
run "reject_invalid_password_hash" {
  command = plan
  variables {
    oauth_password_hash = "not-a-hash"
  }
  expect_failures = [var.oauth_password_hash]
}
