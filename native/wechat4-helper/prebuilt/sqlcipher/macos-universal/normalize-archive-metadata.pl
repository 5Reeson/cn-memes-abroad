#!/usr/bin/perl
use strict;
use warnings;

my ($archive) = @ARGV;
die "usage: normalize-archive-metadata.pl <archive>\n" unless defined $archive;

open my $handle, '+<:raw', $archive or die "cannot open archive: $!\n";
my $length = -s $handle;
read($handle, my $magic, 8) == 8 or die "cannot read archive header\n";
die "invalid archive header\n" unless $magic eq "!<arch>\n";

my $offset = 8;
while ($offset < $length) {
  seek($handle, $offset, 0) or die "cannot seek to member header\n";
  read($handle, my $header, 60) == 60 or die "truncated archive member header\n";
  die "invalid archive member header\n" unless substr($header, 58, 2) eq "`\n";

  my $size_text = substr($header, 48, 10);
  $size_text =~ s/\s+\z//;
  die "invalid archive member size\n" unless $size_text =~ /\A\d+\z/;
  my $member_size = int($size_text);

  # BSD ar stores decimal mtime, uid, and gid fields in every member header.
  # Normalize them without touching mode, size, symbol data, or object bytes.
  substr($header, 16, 12, "0           ");
  substr($header, 28, 6, "0     ");
  substr($header, 34, 6, "0     ");
  seek($handle, $offset, 0) or die "cannot seek to rewrite member header\n";
  print {$handle} $header or die "cannot rewrite member header\n";

  $offset += 60 + $member_size;
  $offset++ if $offset % 2;
  die "archive member exceeds file length\n" if $offset > $length;
}

die "archive length mismatch\n" unless $offset == $length;
close $handle or die "cannot close archive: $!\n";
