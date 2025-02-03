
from git_filter_repo import Commit
def filter_commit(commit):
    if commit.author_email == 'albertomoro98@gmail.com':
        commit.skip()

